#!/usr/bin/env bash
# Create the Concord Python toolkit virtualenv (toolkit/.venv) with LinkML, which the core
# tests use to check generated LinkML schemas. Nothing at runtime needs Python: OWL reasoning
# is sparq (WebAssembly).
# Requires `uv` (https://docs.astral.sh/uv/) or python3.
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found; falling back to python3 -m venv + pip" >&2
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
else
  [[ -d .venv ]] || uv venv .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi
echo "toolkit ready: $(pwd)/.venv/bin/python"
