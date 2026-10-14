#!/usr/bin/env bash
# Create the Concord Python toolkit virtualenv (toolkit/.venv).
#   ./toolkit/setup.sh            # owlready2 only (reasoning)
#   ./toolkit/setup.sh --linkml   # also install LinkML (used to validate generated schemas in tests)
# Requires `uv` (https://docs.astral.sh/uv/) and Java 11+ on PATH for HermiT/Pellet.
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found; falling back to python3 -m venv + pip" >&2
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  [[ "${1:-}" == "--linkml" ]] && .venv/bin/pip install linkml
else
  [[ -d .venv ]] || uv venv .venv
  uv pip install --python .venv/bin/python -r requirements.txt
  [[ "${1:-}" == "--linkml" ]] && uv pip install --python .venv/bin/python linkml
fi
command -v java >/dev/null 2>&1 || echo "warning: java not found; owlReasoner will fall back to the structural reasoner" >&2
echo "toolkit ready: $(pwd)/.venv/bin/python"
