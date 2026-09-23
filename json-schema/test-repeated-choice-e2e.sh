#!/usr/bin/env bash
# Run from any directory: bash json-schema/test-repeated-choice-e2e.sh
# Requires the existing Maven classpath and a compatible JDK (21+).
# Set JAVA_BIN to a JDK executable if the default java is older.
# No downloads, source changes, collapse, or generated-src overwrites.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
JAVA_BIN="${JAVA_BIN:-java}"
if [ ! -s target/classpath.txt ]; then
  echo 'Missing target/classpath.txt. Resolve the Maven dependencies first.' >&2
  exit 2
fi
CP="$(cat target/classpath.txt)"
# The converter splits script.args on whitespace; use a path without spaces.
OUT_DIR="$(mktemp -d /tmp/netex-repeated-choice.XXXXXX)"
echo "Test output retained in: $OUT_DIR"
run_converter() {
  "$JAVA_BIN" "-Dscript.args=$1" -cp "$CP" \
    com.oracle.truffle.js.shell.JSLauncher \
    --experimental-options --js.ecmascript-version=2022 \
    --engine.WarnInterpreterOnly=false xsd-to-jsonschema.js
}
run_converter "test-fixtures/repeated-choice $OUT_DIR/fixture"
run_converter "../xsd/2.0 $OUT_DIR/netex ../assembly-config.json --sub-graph passengerSpots_RelStructure"
python3 test-repeated-choice.py "$OUT_DIR/fixture/base.schema.json" \
  "$OUT_DIR/netex/base@passengerSpots_RelStructure.schema.json"
