#!/bin/bash
# Runs every e2e suite, 6 at a time, each on its own port (E2E_PORT, see common.py).
# Results: one file per suite in $OUT_DIR (default /tmp/e2e), then a summary.
# Run from anywhere: bash dev/e2e/run_all.sh
cd "$(dirname "$0")"
OUT_DIR=${OUT_DIR:-/tmp/e2e}
mkdir -p "$OUT_DIR" && rm -f "$OUT_DIR"/*.txt
i=0
for t in $(ls *.py | grep -v common.py); do
  port=$((9000 + i)); i=$((i + 1))
  ( E2E_PORT=$port timeout 400 python3 "$t" > "$OUT_DIR/${t%.py}.txt" 2>&1; echo "exit $?" >> "$OUT_DIR/${t%.py}.txt" ) &
  while [ "$(jobs -r | wc -l)" -ge 6 ]; do sleep 2; done
done
wait
ok=0; total=0
for f in "$OUT_DIR"/*.txt; do
  total=$((total + 1))
  if grep -q '^exit 0' "$f"; then ok=$((ok + 1)); else echo "FAILED: $(basename "$f" .txt) — $(grep -E '^FAIL|Error' "$f" | head -1)"; fi
done
echo "$ok/$total suites passed"
[ "$ok" -eq "$total" ]
