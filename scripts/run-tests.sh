#!/usr/bin/env bash
# Runs every JavaScript and Python suite from the repository root.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
report() {
  # In GitHub Actions, surface the failing suite and its last lines as an annotation.
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::error title=FAIL %s::%s\n' "$1" "$(tail -15 /tmp/vms-test.log | sed ':a;N;$!ba;s/%/%25/g;s/\r/%0D/g;s/\n/%0A/g')"
  fi
}
for f in test-*.cjs; do
  if node "$f" >/tmp/vms-test.log 2>&1; then echo "PASS $f"; else echo "FAIL $f"; cat /tmp/vms-test.log; report "$f"; fail=1; fi
done
for f in test-*.py; do
  if python3 -B "$f" >/tmp/vms-test.log 2>&1; then echo "PASS $f"; else echo "FAIL $f"; cat /tmp/vms-test.log; report "$f"; fail=1; fi
done
exit $fail
