<#
.SYNOPSIS
  Creates the pilot login for a VKS target cluster and writes a kubeconfig for it.
.DESCRIPTION
  Windows/PowerShell version of pilot-kubeconfig.sh. The service account can create, check and
  delete a pilot Deployment and its Services in ONE namespace, and read what the pilot checks need.
  Each namespace gets its own service account. The kubeconfig's context is named
  "<Context>-pilot-<Namespace>". The namespace must already exist.
.EXAMPLE
  .\pilot-kubeconfig.ps1 -Context my-vks-context -Namespace payments -Output payments-pilot.kubeconfig
#>
param(
  [Parameter(Mandatory = $true)][string]$Context,
  [Parameter(Mandatory = $true)][string]$Namespace,
  [string]$Output
)
# 'Continue': under 'Stop', Windows PowerShell 5.1 turns kubectl's stderr into a terminating error before
# the exit code can be checked. Native calls check $LASTEXITCODE; cmdlets use -ErrorAction Stop.
$ErrorActionPreference = 'Continue'
$saNs = 'vks-migration-studio-pilot'
$name = "vks-migration-studio-pilot-$Namespace"
$pilot = "$Context-pilot-$Namespace"
if (-not $Output) { $Output = "$pilot.kubeconfig" }

if (Test-Path -LiteralPath $Output) { throw "$Output already exists; choose another file name." }
if ($Context -notmatch '^[A-Za-z0-9._@:/][A-Za-z0-9._@:/-]*$') { throw "Context name '$Context' has unusual characters; rename it with kubectl config rename-context first." }
if ($Namespace -notmatch '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$') { throw "'$Namespace' is not a valid namespace name." }
& kubectl --context $Context get namespace $Namespace *> $null
if ($LASTEXITCODE -ne 0) { throw "Namespace $Namespace does not exist on $Context. Create it with the labels, quotas and policies it needs first." }

$rbac = @(
  (Join-Path $PSScriptRoot '..\deploy\kubernetes\pilot-rbac.yaml'),
  (Join-Path $PSScriptRoot 'pilot-rbac.yaml')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $rbac) { throw 'pilot-rbac.yaml not found next to this script or in deploy\kubernetes\.' }
$yaml = (Get-Content -Raw -LiteralPath $rbac -ErrorAction Stop).Replace('__NAMESPACE__', $Namespace).Replace('__NAME__', $name)
$yaml | & kubectl --context $Context apply -f - | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'kubectl apply failed.' }

Write-Host 'Waiting for the token...'
$tokenB64 = ''
for ($i = 0; $i -lt 30 -and -not $tokenB64; $i++) {
  $tokenB64 = (& kubectl --context $Context -n $saNs get secret "$name-token" -o 'jsonpath={.data.token}' 2>$null)
  if (-not $tokenB64) { Start-Sleep -Seconds 1 }
}
if (-not $tokenB64) { throw "The service account token was not issued. Check the cluster's token controller." }
$token = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($tokenB64 | Out-String).Trim()))
$ca = (& kubectl --context $Context -n $saNs get secret "$name-token" -o 'jsonpath={.data.ca\.crt}' | Out-String).Trim()
$server = (& kubectl config view --minify --context $Context -o 'jsonpath={.clusters[0].cluster.server}' | Out-String).Trim()
if (-not $server) { throw "Could not read the API server address for context $Context." }

$kubeconfig = @"
apiVersion: v1
kind: Config
clusters:
  - name: $pilot
    cluster:
      server: $server
      certificate-authority-data: $ca
users:
  - name: $pilot
    user:
      token: $token
contexts:
  - name: $pilot
    context: { cluster: $pilot, user: $pilot, namespace: $Namespace }
current-context: $pilot
"@

$null = New-Item -ItemType File -Path $Output -ErrorAction Stop
$full = (Resolve-Path -LiteralPath $Output -ErrorAction Stop).Path
if ($IsLinux -or $IsMacOS) {
  & chmod 600 $full
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $full -AclObject $acl -ErrorAction Stop
}
[IO.File]::WriteAllText($full, $kubeconfig, (New-Object Text.UTF8Encoding($false)))
Write-Host "Wrote $Output with context $pilot (write access to namespace $Namespace only). Keep it private."
Write-Host "Add it to the engine's kubeconfig Secret, then choose $pilot as the pilot login on the Clusters page."
