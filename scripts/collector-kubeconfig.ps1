<#
.SYNOPSIS
  Creates a read-only collector identity in one cluster and writes a kubeconfig for it.
.DESCRIPTION
  Windows/PowerShell version of collector-kubeconfig.sh. Applies collector-rbac.yaml (looked for in
  ..\deploy\kubernetes\ and next to this script), waits for the service account token, and writes a
  kubeconfig the VKS Migration Studio engine uses to collect inventory. The identity can list
  workloads, networking, storage, RBAC and policy objects; it cannot read Secrets, ConfigMaps or
  Pods, or change anything. Run it with your own admin context (for VKS: after kubectl vsphere login).
.EXAMPLE
  .\collector-kubeconfig.ps1 -Context my-vks-context -Output target.kubeconfig
#>
param(
  [Parameter(Mandatory = $true)][string]$Context,
  [string]$Output = "$Context-collector.kubeconfig"
)
$ErrorActionPreference = 'Stop'
$ns = 'vks-migration-studio-collector'
$name = 'vks-migration-studio-collector'

if (Test-Path -LiteralPath $Output) { throw "$Output already exists; choose another file name." }
if ($Context -notmatch '^[A-Za-z0-9._@:/][A-Za-z0-9._@:/-]*$') { throw "Context name '$Context' has unusual characters; rename it with kubectl config rename-context first." }

$rbac = @(
  (Join-Path $PSScriptRoot '..\deploy\kubernetes\collector-rbac.yaml'),
  (Join-Path $PSScriptRoot 'collector-rbac.yaml')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $rbac) { throw 'collector-rbac.yaml not found next to this script or in deploy\kubernetes\.' }

function Invoke-Kubectl([string[]]$Arguments) {
  $result = & kubectl --context $Context @Arguments
  if ($LASTEXITCODE -ne 0) { throw "kubectl $($Arguments -join ' ') failed." }
  return $result
}

Invoke-Kubectl @('apply', '-f', $rbac) | Out-Host

Write-Host 'Waiting for the token...'
$tokenB64 = ''
for ($i = 0; $i -lt 30 -and -not $tokenB64; $i++) {
  $tokenB64 = (& kubectl --context $Context -n $ns get secret "$name-token" -o 'jsonpath={.data.token}' 2>$null)
  if (-not $tokenB64) { Start-Sleep -Seconds 1 }
}
if (-not $tokenB64) { throw "The service account token was not issued. Check the cluster's token controller." }

$token = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($tokenB64 | Out-String).Trim()))
$ca = (Invoke-Kubectl @('-n', $ns, 'get', 'secret', "$name-token", '-o', 'jsonpath={.data.ca\.crt}') | Out-String).Trim()
$server = (& kubectl config view --minify --context $Context -o 'jsonpath={.clusters[0].cluster.server}' | Out-String).Trim()
if (-not $server) { throw "Could not read the API server address for context $Context." }

$kubeconfig = @"
apiVersion: v1
kind: Config
clusters:
  - name: $Context
    cluster:
      server: $server
      certificate-authority-data: $ca
users:
  - name: $Context-collector
    user:
      token: $token
contexts:
  - name: $Context
    context: { cluster: $Context, user: $Context-collector }
current-context: $Context
"@

# Create the file so that only the current user can read it.
$null = New-Item -ItemType File -Path $Output
$full = (Resolve-Path -LiteralPath $Output).Path
if ($IsLinux -or $IsMacOS) {
  & chmod 600 $full
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $full -AclObject $acl
}
[IO.File]::WriteAllText($full, $kubeconfig, (New-Object Text.UTF8Encoding($false)))

Write-Host "Wrote $Output (read-only collector for context $Context). Keep it private: it is a long-lived credential."
Write-Host "Remove the identity later with: kubectl --context $Context delete clusterrolebinding,clusterrole $name; kubectl --context $Context delete namespace $ns"
