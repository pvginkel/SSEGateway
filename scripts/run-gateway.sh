#!/bin/bash

set -euo pipefail

# Run the SSE Gateway in foreground (blocking)
# Used by Playwright tests and testing infrastructure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$(dirname "$SCRIPT_DIR")"  # Parent directory (project root)

echo $GATEWAY_DIR

# Change to gateway directory
cd "$GATEWAY_DIR" || {
    echo "Error: Could not change to gateway directory: $GATEWAY_DIR" >&2
    exit 1
}

# Default configuration
PORT="3000"
CALLBACK_URL=""

print_usage() {
    cat <<'EOF'
Usage: run-gateway.sh --callback-url URL [--port PORT]

Required:
  --callback-url URL       Backend callback URL with secret embedded
                          (e.g., http://localhost:5100/api/sse/callback?secret=test-secret)

Optional:
  --port PORT              Port to listen on (default: 3000)
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --port requires a value." >&2
                print_usage
                exit 1
            fi
            PORT="$2"
            shift 2
            ;;
        --callback-url)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --callback-url requires a value." >&2
                print_usage
                exit 1
            fi
            CALLBACK_URL="$2"
            shift 2
            ;;
        --help|-h)
            print_usage
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            print_usage
            exit 1
            ;;
    esac
done

# Validate required arguments
if [[ -z "$CALLBACK_URL" ]]; then
    echo "Error: --callback-url is required" >&2
    print_usage
    exit 1
fi

# Export environment variables for Node
export PORT="$PORT"
export CALLBACK_URL="$CALLBACK_URL"

# Run the SSE Gateway
echo
echo "Starting SSE Gateway..."
echo "Port: $PORT"
echo "Callback URL: $CALLBACK_URL"
echo "Press Ctrl+C to stop"
echo

exec node dist/index.js
