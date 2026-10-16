#!/usr/bin/env bash
# Runs every JavaScript and Python suite from the repository root.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
for f in test-*.cjs; do
  if node "$f" >/tmp/vms-test.log 2>&1; then echo "PASS $f"; else echo "FAIL $f"; cat /tmp/vms-test.log; fail=1; fi
done
for f in test-*.py; do
  if python3 -B "$f" >/tmp/vms-test.log 2>&1; then echo "PASS $f"; else echo "FAIL $f"; cat /tmp/vms-test.log; fail=1; fi
done
exit $fail
