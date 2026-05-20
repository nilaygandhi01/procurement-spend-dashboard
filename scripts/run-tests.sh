#!/usr/bin/env bash
# Convenience wrapper for the Index Analysis unit tests.
# Runs every *.test.mjs under scripts/tests/ via Node's built-in test runner.
# No npm install / build step required.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/.." && pwd)"

cd "${repo}"
echo "Running scripts/tests/*.test.mjs via node --test ..."
# shellcheck disable=SC2046
node --test $(ls scripts/tests/*.test.mjs)
echo "All tests passed."
