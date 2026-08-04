#!/usr/bin/env bash
set -euo pipefail
APP="${1:?usage: verify-macos-app.sh path/to/App.app}"
RES="$APP/Contents/Resources"
EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
MAIN_EXECUTABLE="$APP/Contents/MacOS/$EXECUTABLE_NAME"

require_directory() {
  [[ -d "$1" ]] || { echo "Required directory is missing: $1" >&2; exit 1; }
}

require_executable() {
  [[ -f "$1" ]] || { echo "Required executable is missing: $1" >&2; exit 1; }
  [[ -x "$1" ]] || { echo "Required file is not executable: $1" >&2; exit 1; }
}

require_file() {
  [[ -s "$1" ]] || { echo "Required file is missing or empty: $1" >&2; exit 1; }
}

require_directory "$APP"
require_executable "$RES/darwin-arm64/whisper/whisper-cli"
require_executable "$RES/darwin-x64/whisper/whisper-cli"
require_executable "$RES/darwin-arm64/ffmpeg/ffmpeg"
require_executable "$RES/darwin-x64/ffmpeg/ffmpeg"
require_executable "$RES/darwin-arm64/yt-dlp/yt-dlp"
require_executable "$RES/darwin-x64/yt-dlp/yt-dlp"
require_file "$RES/models/ggml-small.bin"
require_file "$RES/models/ggml-medium.bin"
require_file "$RES/models/ggml-large-v3-turbo.bin"

for MODEL in ggml-small.bin ggml-medium.bin ggml-large-v3-turbo.bin; do
  SIZE="$(stat -f %z "$RES/models/$MODEL")"
  if [[ "$SIZE" -lt 50000000 ]]; then
    echo "Bundled model is missing or incomplete: $MODEL ($SIZE bytes)" >&2
    exit 1
  fi
done

lipo -archs "$MAIN_EXECUTABLE" | grep -q arm64
lipo -archs "$MAIN_EXECUTABLE" | grep -q x86_64
file "$RES/darwin-arm64/whisper/whisper-cli" | grep -Eq 'arm64|universal binary'
file "$RES/darwin-x64/whisper/whisper-cli" | grep -Eq 'x86_64|universal binary'
codesign --verify --deep --strict --verbose=2 "$APP"

if find "$RES/darwin-arm64" "$RES/darwin-x64" -name '*.exe' | grep -q .; then
  echo 'Windows executable leaked into macOS resources' >&2
  exit 1
fi

echo 'macOS Universal application resource audit passed.'
