#!/usr/bin/env bash
# scripts/download-dictation-model.sh
#
# Download the whisper.cpp ggml-base.en model used by the built-in dictation
# extension's default backend (whisper-cli/whisper-cpp/whisper).
#
# Usage:
#   ./scripts/download-dictation-model.sh
#
# The model lands at ~/.pi/agent/models/ggml-base.en.bin (override with
# PI_DICTATION_MODEL_PATH). The extension looks the model up there by default.
#
# Dependencies: curl. Working directory: any.

set -euo pipefail

DEST="${PI_DICTATION_MODEL_PATH:-$HOME/.pi/agent/models/ggml-base.en.bin}"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

if [[ -f "$DEST" ]]; then
	echo "Model already present at $DEST"
	exit 0
fi

mkdir -p "$(dirname "$DEST")"
echo "Downloading ggml-base.en (~148MB) to $DEST ..."
curl -L --fail --progress-bar -o "$DEST" "$URL"
echo "Done: $DEST"