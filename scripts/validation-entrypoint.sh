#!/usr/bin/env bash
set -uo pipefail

RESULTS_DIR=/app/results
mkdir -p "$RESULTS_DIR"

# Sum one numeric attribute over every <testsuite ...> element (never the root).
sum_attr() {
    grep -o '<testsuite [^>]*' "$2" | sed -nE "s/.* $1=\"([0-9]+)\".*/\1/p" | awk '{ s += $1 } END { print s + 0 }'
}

export_results() {
    echo "=== Exporting test results ==="
    for f in "$RESULTS_DIR"/*.xml; do
        [ -f "$f" ] || continue

        name=$(basename "$f" .xml)
        # jest-junit's root <testsuites> element carries tests/failures/errors
        # but no skipped, so every count is summed over the <testsuite> elements.
        tests=$(sum_attr tests "$f")
        failures=$(sum_attr failures "$f")
        errors=$(sum_attr errors "$f")
        skipped=$(sum_attr skipped "$f")
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
