#!/usr/bin/env bash
# scripts/download-model.sh
#
# Download and extract the sherpa-onnx streaming EN model used by pi-dictation.
#
# Usage:
#   ./scripts/download-model.sh
#
# The model lands in ~/.pi/agent/models/dictation-en-20m (override with
# PI_DICTATION_MODEL_DIR). The extension looks the model up there.
#
# Dependencies: curl, tar. Working directory: any.

set -euo pipefail

MODEL_NAME="sherpa-onnx-streaming-zipformer-en-20M-2023-02-17"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2"

DEST_DIR="${PI_DICTATION_MODEL_DIR:-$HOME/.pi/agent/models}"
TARGET="$DEST_DIR/$MODEL_NAME"

if [[ -d "$TARGET" ]]; then
	echo "Model already present at $TARGET"
	exit 0
fi

mkdir -p "$DEST_DIR"
echo "Downloading $MODEL_NAME (~122MB)..."
curl -L --fail --progress-bar -o "$DEST_DIR/model.tar.bz2" "$MODEL_URL"
echo "Extracting..."
tar xjf "$DEST_DIR/model.tar.bz2" -C "$DEST_DIR"
rm -f "$DEST_DIR/model.tar.bz2"
echo "Done: $TARGET"