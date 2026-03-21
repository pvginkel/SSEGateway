#!/usr/bin/env bash
set -uo pipefail

RESULTS_DIR=/app/results
mkdir -p "$RESULTS_DIR"

export_results() {
    echo "=== Exporting test results ==="
    for f in "$RESULTS_DIR"/*.xml; do
        [ -f "$f" ] || continue

        name=$(basename "$f" .xml)
        tests=$(sed -nE 's/.*tests="([0-9]+)".*/\1/p' "$f" | head -1)
        failures=$(sed -nE 's/.*failures="([0-9]+)".*/\1/p' "$f" | head -1)
        errors=$(sed -nE 's/.*errors="([0-9]+)".*/\1/p' "$f" | head -1)
        skipped=$(sed -nE 's/.*skipped="([0-9]+)".*/\1/p' "$f" | head -1)
        tests=${tests:-0}; failures=${failures:-0}; errors=${errors:-0}; skipped=${skipped:-0}
        failed=$((failures + errors))
        passed=$((tests - failed - skipped))
        echo "===SUITE_RESULT:${name}:${passed}:${failed}:${skipped}==="

        echo "===JUNIT:$(basename "$f")==="
        base64 "$f"
        echo "===JUNIT_END==="
    done
}
trap export_results EXIT

exit_code=0

echo "=== Waiting for RabbitMQ to complete startup ==="
until nc -zv localhost 5672 2>/dev/null; do sleep 1; done

echo "=== Running tests ==="
RABBITMQ_URL=amqp://guest:guest@localhost:5672/ \
    JEST_JUNIT_OUTPUT_DIR="$RESULTS_DIR" \
    JEST_JUNIT_OUTPUT_NAME="ssegateway.xml" \
    node --experimental-vm-modules node_modules/jest/bin/jest.js \
    --reporters=default --reporters=jest-junit \
    || exit_code=$?

exit $exit_code
