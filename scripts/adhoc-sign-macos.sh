#!/usr/bin/env bash
set -euo pipefail

APP="${1:?usage: adhoc-sign-macos.sh path/to/App.app}"

find "$APP/Contents/Resources/darwin-arm64" "$APP/Contents/Resources/darwin-x64" \
  -type f \( -name whisper-cli -o -name ffmpeg -o -name yt-dlp -o -name '*.dylib' \) \
  -exec chmod 755 {} +

find "$APP/Contents/Resources/darwin-arm64" "$APP/Contents/Resources/darwin-x64" \
  -type f -perm +111 -print0 | while IFS= read -r -d '' FILE; do
    codesign --force --sign - --timestamp=none "$FILE" || true
  done

codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
