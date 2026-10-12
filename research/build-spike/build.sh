#!/usr/bin/env bash
# 拋棄式 spike（#10）：在 Docker 內 build libav.js 自訂 variant 並量體積。
# 用法：[JOBS=4] research/build-spike/build.sh <工作目錄> [variant ...]（JOBS 模擬 CI runner 的核心數）
# 產物在 <工作目錄>/libav.js/dist，不進 git。
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mkdir -p "$1" && cd "$1" && pwd); shift

LIBAVJS_TAG=v6.10.9.0
LIBAVJS_COMMIT=c80e885c3461f7bb7ea565c9631b34243ae0dbf1
LIBAVJS_VERSION=6.10.9.0
FFMPEG_VERSION=9.0
FFMPEG_SHA256=7f607a00dd0d28a729d5a4811205812eef01cf6ef6155025febb6f36a9062d52
ZLIB_VERSION=1.3.2
ZLIB_SHA256=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
OPUS_VERSION=1.6.1
OPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
EMFT_VERSION=1.3   # emfiberthreads（0BSD），base target 一律連結
EMFT_SHA256=0fe933d7742de3b3213608e0fb087a1ae0d060604d5835f7c9cdfcee0fc8cbcb
IMAGE=kikoeru-libavjs-build:spike

source "$HERE/variants.sh"
[ $# -gt 0 ] || set -- "${!VARIANTS[@]}"

# 1. 原始碼：釘 tag 並核對 commit，再打 wrapper patch（0BSD 的 libav.js 部分，不動 FFmpeg）
if [ ! -d "$WORK/libav.js" ]; then
  git clone -q --depth 1 --branch "$LIBAVJS_TAG" https://github.com/Yahweasel/libav.js "$WORK/libav.js"
  [ "$(git -C "$WORK/libav.js" rev-parse HEAD)" = "$LIBAVJS_COMMIT" ] || { echo "tag moved" >&2; exit 1; }
  patch -d "$WORK/libav.js" -p1 < "$HERE/libavjs-accessors.patch"
fi

# 2. 上游 tarball：先放進 build/ 並核對 sha256，Makefile 就不會再自己 curl（它本身不驗證）
mkdir -p "$WORK/libav.js/build"
fetch() { # url file sha256
  [ -f "$2" ] || curl -sSfL "$1" -o "$2"
  echo "$3  $2" | sha256sum -c --quiet -
}
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$WORK/libav.js/build/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"
fetch "https://www.zlib.net/fossils/zlib-$ZLIB_VERSION.tar.gz" "$WORK/libav.js/build/zlib-$ZLIB_VERSION.tar.gz" "$ZLIB_SHA256"
fetch "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz" "$WORK/libav.js/build/opus-$OPUS_VERSION.tar.gz" "$OPUS_SHA256"
fetch "https://github.com/Yahweasel/emfiberthreads/archive/refs/tags/v$EMFT_VERSION.tar.gz" "$WORK/libav.js/build/emfiberthreads-$EMFT_VERSION.tar.gz" "$EMFT_SHA256"

# 3. build image
docker build -q -t "$IMAGE" "$HERE" >/dev/null

run() {
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp ${JOBS:+--cpus=$JOBS} \
    -v "$WORK/libav.js:/work/libav.js" "$IMAGE" bash -c "$1"
}

run 'test -d node_modules || npm ci --silent'

for v in "$@"; do
  run "cd configs && ./mkconfig.js $v '${VARIANTS[$v]}'"
  start=$(date +%s)
  run "make -j${JOBS:-\$(nproc)} dist/libav-$LIBAVJS_VERSION-$v.wasm.mjs dist/libav-$LIBAVJS_VERSION-$v.mjs dist/libav.types.d.ts" \
    > "$WORK/build-$v.log" 2>&1 || { tail -40 "$WORK/build-$v.log"; exit 1; }
  echo "$v: build $(( $(date +%s) - start ))s"
done

node "$HERE/measure.mjs" "$WORK/libav.js/dist" "$LIBAVJS_VERSION" "$@"
