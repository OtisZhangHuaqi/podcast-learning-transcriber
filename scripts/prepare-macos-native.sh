#!/usr/bin/env bash
set -euo pipefail

ARCH="${1:?usage: prepare-macos-native.sh arm64|x64}"
case "$ARCH" in arm64|x64) ;; *) echo "unsupported arch: $ARCH" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/darwin-$ARCH"
WORK="${RUNNER_TEMP:-/tmp}/podcast-native-$ARCH"
WHISPER_TAG="v1.9.1"

rm -rf "$DEST" "$WORK"
mkdir -p "$DEST/whisper" "$DEST/ffmpeg" "$DEST/yt-dlp" "$WORK"

git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git "$WORK/whisper.cpp"
cmake -S "$WORK/whisper.cpp" -B "$WORK/whisper.cpp/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL="$([[ "$ARCH" == arm64 ]] && echo ON || echo OFF)" \
  -DGGML_NATIVE=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF
cmake --build "$WORK/whisper.cpp/build" --config Release --target whisper-cli -j "$(sysctl -n hw.logicalcpu)"

WHISPER_BIN="$(find "$WORK/whisper.cpp/build" -type f -name whisper-cli -perm +111 | head -n 1)"
test -n "$WHISPER_BIN"
cp "$WHISPER_BIN" "$DEST/whisper/whisper-cli"

mkdir -p "$WORK/ffmpeg-static"
npm install --prefix "$WORK/ffmpeg-static" --ignore-scripts=false ffmpeg-static@5.3.0
FFMPEG_BIN="$(node -e "process.stdout.write(require('$WORK/ffmpeg-static/node_modules/ffmpeg-static'))")"
cp "$FFMPEG_BIN" "$DEST/ffmpeg/ffmpeg"

curl --fail --location --retry 3 \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos \
  --output "$DEST/yt-dlp/yt-dlp"

chmod 755 "$DEST/whisper/"* "$DEST/ffmpeg/ffmpeg" "$DEST/yt-dlp/yt-dlp"
"$DEST/whisper/whisper-cli" --help >/dev/null
if otool -L "$DEST/whisper/whisper-cli" | grep -Eq '@rpath/(libwhisper|libggml)|podcast-native-.*/whisper.cpp/build'; then
  echo 'whisper-cli still references build-time whisper.cpp libraries' >&2
  otool -L "$DEST/whisper/whisper-cli" >&2
  exit 1
fi
file "$DEST/whisper/whisper-cli" "$DEST/ffmpeg/ffmpeg" "$DEST/yt-dlp/yt-dlp"
shasum -a 256 "$DEST/whisper/"* "$DEST/ffmpeg/ffmpeg" "$DEST/yt-dlp/yt-dlp" > "$DEST/SHA256SUMS.txt"
