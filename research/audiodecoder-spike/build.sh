#!/usr/bin/env bash
# 拋棄式 spike（#18）：build 實測用的 libav.js variant（kikoeru-af）。
# 沿用 research/ffmpeg-wasm-build branch 的 research/build-spike（#10），依序打三個 patch：
#   1. build-spike/libavjs-accessors.patch（#10：AVStream disposition／start_time 等）
#   2. avio-accessors.patch（#17：AVIOContext error／eof_reached）
#   3. codecpar-accessors.patch（本 spike：AVCodecParameters 的 initial_padding／trailing_padding／seek_preroll／frame_size 等）
# 用法：research/audiodecoder-spike/build.sh <build-spike 目錄> <工作目錄>
# 產物在 <工作目錄>/libav.js/dist，不進 git。
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SPIKE=$(cd "$1" && pwd)
WORK=$(mkdir -p "$2" && cd "$2" && pwd)
V=6.10.9.0
TARBALL_SHA256=3b640c356d74724a99230b077ef442d8c995a37c03e0729d6d2a9be0f3a41fd3   # GitHub archive of tag v6.10.9.0

if [ ! -d "$WORK/libav.js" ]; then
  curl -sSfL "https://github.com/Yahweasel/libav.js/archive/refs/tags/v$V.tar.gz" -o "$WORK/libavjs.tar.gz"
  echo "$TARBALL_SHA256  $WORK/libavjs.tar.gz" | sha256sum -c --quiet -
  tar xzf "$WORK/libavjs.tar.gz" -C "$WORK" && mv "$WORK/libav.js-$V" "$WORK/libav.js"
  patch -s -d "$WORK/libav.js" -p1 -i "$SPIKE/libavjs-accessors.patch"
  patch -s -d "$WORK/libav.js" -p1 -i "$HERE/avio-accessors.patch"
  patch -s -d "$WORK/libav.js" -p1 -i "$HERE/codecpar-accessors.patch"
fi

# build-spike 看到 libav.js 已存在就不會再 clone，只下載並核對 FFmpeg 等 tarball 後 build
"$SPIKE/build.sh" "$WORK" kikoeru-af
ls -la "$WORK/libav.js/dist"
