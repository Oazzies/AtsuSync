#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
./setup.sh || true

echo ""
read -r -p "Press Enter to close..."
