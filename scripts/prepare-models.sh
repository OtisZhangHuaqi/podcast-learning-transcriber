#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/models"
BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
mkdir -p "$DEST"
for MODEL in ggml-small.bin ggml-medium.bin ggml-large-v3-turbo.bin; do
  if [[ ! -s "$DEST/$MODEL" ]]; then
    curl --fail --location --retry 3 "$BASE/$MODEL" --output "$DEST/$MODEL.download"
    mv "$DEST/$MODEL.download" "$DEST/$MODEL"
  fi
done
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$DEST"/ggml-*.bin > "$DEST/SHA256SUMS.txt"
else
  sha256sum "$DEST"/ggml-*.bin > "$DEST/SHA256SUMS.txt"
fi
