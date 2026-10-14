#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CloudOps NOC Dashboard — Startup Script
# ─────────────────────────────────────────────────────────────────────────────

set -e

VENV_DIR=".venv"
PORT=${PORT:-5000}
HOST=${HOST:-0.0.0.0}

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   CloudOps NOC Dashboard  v1.0.0         ║"
echo "  ║   Production Monitoring System           ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# Create virtual environment if needed
if [ ! -d "$VENV_DIR" ]; then
  echo "  → Creating virtual environment…"
  python3 -m venv "$VENV_DIR"
fi

# Activate and install
echo "  → Installing dependencies…"
source "$VENV_DIR/bin/activate"
pip install -q -r requirements.txt

# Create log dir
mkdir -p logs

echo "  → Starting server on http://$HOST:$PORT"
echo "  → Press Ctrl+C to stop"
echo ""

python app.py
