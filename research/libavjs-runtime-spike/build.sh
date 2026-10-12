#!/usr/bin/env bash
# 拋棄式 spike（#17）：build 實測用的 libav.js variant。
# 沿用 research/ffmpeg-wasm-build branch 的 research/build-spike（#10），只多兩件事：
#   1. 多打 avio-accessors.patch（AVIOContext_error／eof_reached accessor，驗證中止後重設是否足夠）
#   2. 另外 link 一份不開 Asyncify 的 glue＋wasm（kikoeru-af-noasyncify），只用來量 Asyncify 的速度代價
# 用法：research/libavjs-runtime-spike/build.sh <build-spike 目錄> <工作目錄>
# 產物在 <工作目錄>/libav.js/dist，不進 git。
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SPIKE=$(cd "$1" && pwd)
WORK=$(mkdir -p "$2" && cd "$2" && pwd)
V=6.10.9.0
TARBALL_SHA256=3b640c356d74724a99230b077ef442d8c995a37c03e0729d6d2a9be0f3a41fd3   # GitHub archive of tag v6.10.9.0

# 1. 原始碼：用 tag 的 archive（commit c80e885），先打 #10 的 accessor patch，再打本 spike 的 AVIOContext patch
if [ ! -d "$WORK/libav.js" ]; then
  curl -sSfL "https://github.com/Yahweasel/libav.js/archive/refs/tags/v$V.tar.gz" -o "$WORK/libavjs.tar.gz"
  echo "$TARBALL_SHA256  $WORK/libavjs.tar.gz" | sha256sum -c --quiet -
  tar xzf "$WORK/libavjs.tar.gz" -C "$WORK" && mv "$WORK/libav.js-$V" "$WORK/libav.js"
  patch -s -d "$WORK/libav.js" -p1 < "$SPIKE/libavjs-accessors.patch"
  patch -s -d "$WORK/libav.js" -p1 < "$HERE/avio-accessors.patch"
fi

# 2. 正式 variant（Asyncify）：交給 build-spike（它看到 libav.js 已存在就不會再 clone）
"$SPIKE/build.sh" "$WORK" kikoeru-af

# 3. 同一份 FFmpeg 物件檔，拿掉 -s ASYNCIFY／ASYNCIFY_IMPORTS 重新 link（block reader 不能用，只能讀 MEMFS）
D="$WORK/libav.js/dist"
mkdir -p "$WORK/keep" && cp "$D/libav-$V-kikoeru-af.wasm."* "$WORK/keep/" && rm "$D/libav-$V-kikoeru-af.wasm.mjs"
EF='`tools/memory-init-file-emcc.sh` --pre-js src/pre.js -s "EXPORT_NAME='"'"'LibAVFactory'"'"'" -s MODULARIZE=1 -s STACK_SIZE=1048576 -s INITIAL_MEMORY=25165824 -s ALLOW_MEMORY_GROWTH=1 -s WASM_BIGINT=0'
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$WORK/libav.js:/work/libav.js" kikoeru-libavjs-build:spike \
  make "dist/libav-$V-kikoeru-af.wasm.mjs" "EFLAGS=$EF" > "$WORK/build-noasyncify.log" 2>&1 || { tail -20 "$WORK/build-noasyncify.log"; exit 1; }
mv "$D/libav-$V-kikoeru-af.wasm.wasm" "$D/libav-$V-kikoeru-af-noasyncify.wasm.wasm"
# 沒有 Asyncify 時 ccall 的 {async:true} 會直接回傳數值，但 libav.js 的 post code 會對它呼叫 .then，所以包成 Promise
sed -e "s/libav-$V-kikoeru-af.wasm.wasm/libav-$V-kikoeru-af-noasyncify.wasm.wasm/g" \
    -e 's/return(\.\.\.args)=>ccall(ident,returnType,argTypes,args,opts)}/return opts\&\&opts.async?(...args)=>Promise.resolve(ccall(ident,returnType,argTypes,args,opts)):(...args)=>ccall(ident,returnType,argTypes,args,opts)}/' \
    "$D/libav-$V-kikoeru-af.wasm.mjs" > "$D/libav-$V-kikoeru-af-noasyncify.wasm.mjs"
grep -q 'Promise.resolve(ccall' "$D/libav-$V-kikoeru-af-noasyncify.wasm.mjs"
cp "$WORK/keep/"* "$D/"
ls -la "$D"
