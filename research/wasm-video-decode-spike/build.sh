#!/usr/bin/env bash
# 拋棄式 spike（#20）：build 含 dav1d 的 libav.js variant，並產生量測用的各種組合。
# 用法：[JOBS=n] research/wasm-video-decode-spike/build.sh <工作目錄> [flavor ...]
#   flavor：oz（libav.js 預設 OPTFLAGS=-Oz）、o3（-O3）、o3s（-O3 -msimd128）、
#           mix（FFmpeg 與 link 維持 -Oz，只有 dav1d 用 -O3 -msimd128；改 mk/libdav1d.mk 的 c_args）。預設 oz o3 o3s。
# 產物：<工作目錄>/dist（合併後、檔名帶 flavor），build log 在 <工作目錄>/<flavor>/build-*.log。不進 git。
#
# libav.js 版本：dav1d 只在 master（PR #108，2026-08-30 merge），沒有任何 tag 或 npm release 含它，
# 所以釘 commit c05a676（= v6.10.9.0 + dav1d 的兩個 commit + CI 改動），產物版本字串仍是 6.10.9.0。
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mkdir -p "$1" && cd "$1" && pwd); shift
[ $# -gt 0 ] || set -- oz o3 o3s

LIBAVJS_COMMIT=c05a676d16c1068cce6115594858c50a7ecad4b8
LIBAVJS_SHA256=c12aed563e0dd3fd5870af3366d36d252ef895ac1f689402cb7b07b0f5dbe18b   # GitHub archive of the commit
V=6.10.9.0
FFMPEG_VERSION=9.0
FFMPEG_SHA256=7f607a00dd0d28a729d5a4811205812eef01cf6ef6155025febb6f36a9062d52
EMFT_VERSION=1.3
EMFT_SHA256=0fe933d7742de3b3213608e0fb087a1ae0d060604d5835f7c9cdfcee0fc8cbcb
DAV1D_VERSION=1.5.4   # 由 libav.js mk/libdav1d.mk 決定
DAV1D_SHA256=2abfb0c89212e6e4733a54e0ae509ec00a5b845a6360946f918806e14aedb011
IMAGE=kikoeru-libavjs-build:dav1d

source "$HERE/variants.sh"
declare -A OPT=([oz]="-Oz" [o3]="-O3" [o3s]="-O3 -msimd128" [mix]="-Oz")

fetch() { # url file sha256
  [ -f "$2" ] || curl -sSfL "$1" -o "$2"
  echo "$3  $2" | sha256sum -c --quiet -
}

# 1. 原始碼：commit archive，打 #10／#17／#18 的 0BSD wrapper patch（跟正式 variant 一致）
mkdir -p "$WORK/dl"
fetch "https://github.com/Yahweasel/libav.js/archive/$LIBAVJS_COMMIT.tar.gz" "$WORK/dl/libavjs.tar.gz" "$LIBAVJS_SHA256"
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$WORK/dl/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"
fetch "https://github.com/Yahweasel/emfiberthreads/archive/refs/tags/v$EMFT_VERSION.tar.gz" "$WORK/dl/emfiberthreads-$EMFT_VERSION.tar.gz" "$EMFT_SHA256"
fetch "https://code.videolan.org/videolan/dav1d/-/archive/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.bz2" "$WORK/dl/dav1d-$DAV1D_VERSION.tar.bz2" "$DAV1D_SHA256"

docker build -q -t "$IMAGE" "$HERE" >/dev/null
run() { # tree cmd
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp ${JOBS:+--cpus=$JOBS} -v "$1:/work/libav.js" "$IMAGE" bash -c "$2"
}

# Asyncify 拿掉後的 EFLAGS（其餘與 libav.js Makefile 相同），只用來量 Asyncify 對 dav1d 的速度代價
NOASY='`tools/memory-init-file-emcc.sh` --pre-js src/pre.js -s "EXPORT_NAME='"'"'LibAVFactory'"'"'" -s MODULARIZE=1 -s STACK_SIZE=1048576 -s INITIAL_MEMORY=25165824 -s ALLOW_MEMORY_GROWTH=1 -s WASM_BIGINT=0'
# 沒有 Asyncify 時 ccall 的 {async:true} 會直接回傳數值，libav.js 的 post code 會對它呼叫 .then，所以包成 Promise
# 改名後 glue 內寫死的檔名（pthread Worker 會 new Worker(new URL("<原檔名>.thr.mjs", import.meta.url))）也要跟著改
rename() { sed -e "s/libav-$V-$2\.$3\.mjs/libav-$V-$2-$4.$3.mjs/g; s/libav-$V-$2\.$5/libav-$V-$2-$4.$3.wasm/g" "$1"; }
promisify() { sed -e 's/return(\.\.\.args)=>ccall(ident,returnType,argTypes,args,opts)}/return opts\&\&opts.async?(...args)=>Promise.resolve(ccall(ident,returnType,argTypes,args,opts)):(...args)=>ccall(ident,returnType,argTypes,args,opts)}/' "$1"; }

OUT="$WORK/dist"; mkdir -p "$OUT"
for fl in "$@"; do
  T="$WORK/$fl/libav.js"
  if [ ! -d "$T" ]; then
    mkdir -p "$WORK/$fl"
    tar xzf "$WORK/dl/libavjs.tar.gz" -C "$WORK/$fl" && mv "$WORK/$fl/libav.js-$LIBAVJS_COMMIT" "$T"
    for p in libavjs-accessors avio-accessors codecpar-accessors; do patch -s -d "$T" -p1 -i "$HERE/$p.patch"; done
    mkdir -p "$T/build" && cp "$WORK/dl/"{ffmpeg-*,emfiberthreads-*,dav1d-*} "$T/build/"
    [ "$fl" = mix ] && sed -i 's/-Dc_args="$(OPTFLAGS) /-Dc_args="-O3 -msimd128 /' "$T/mk/libdav1d.mk"
  fi
  run "$T" 'test -d node_modules || npm ci --silent'
  MK="make -j${JOBS:-\$(nproc)} OPTFLAGS='${OPT[$fl]}'"
  # oz：三個 variant 都 build（體積比較）；o3／o3s：只 build 獨立的 kikoeru-dav1d（速度比較）
  vs=(kikoeru-dav1d); [ "$fl" = oz ] && vs=(kikoeru-af kikoeru-afv kikoeru-dav1d); [ "$fl" = mix ] && vs=(kikoeru-afv kikoeru-dav1d)
  for v in "${vs[@]}"; do
    run "$T" "cd configs && ./mkconfig.js $v '${VARIANTS[$v]}'"
    tg="dist/libav-$V-$v.wasm.mjs dist/libav-$V-$v.mjs"
    [ "$v" = kikoeru-dav1d ] && tg="$tg dist/libav-$V-$v.thr.mjs"
    s=$(date +%s)
    run "$T" "$MK $tg" > "$WORK/$fl/build-$v.log" 2>&1 || { tail -40 "$WORK/$fl/build-$v.log"; exit 1; }
    echo "$fl $v: build $(( $(date +%s) - s ))s"
    cp "$T/dist/libav-$V-$v.mjs" "$OUT/libav-$V-$v.mjs"
    for tgt in wasm thr; do
      ext=$([ $tgt = wasm ] && echo wasm.wasm || echo thr.wasm)
      [ -f "$T/dist/libav-$V-$v.$ext" ] || continue
      rename "$T/dist/libav-$V-$v.$tgt.mjs" "$v" "$tgt" "$fl" "$ext" > "$OUT/libav-$V-$v-$fl.$tgt.mjs"
      cp "$T/dist/libav-$V-$v.$ext" "$OUT/libav-$V-$v-$fl.$tgt.wasm"
    done
    # 同一份物件檔、不開 Asyncify 重新 link（只有 kikoeru-dav1d：獨立的 decoder wasm 不做 I/O，不需要 Asyncify）
    if [ "$v" = kikoeru-dav1d ]; then
      for tgt in wasm thr; do
        ext=$([ $tgt = wasm ] && echo wasm.wasm || echo thr.wasm)
        rm -f "$T/dist/libav-$V-$v.$tgt.mjs"
        run "$T" "make OPTFLAGS='${OPT[$fl]}' dist/libav-$V-$v.$tgt.mjs EFLAGS='$NOASY'" > "$WORK/$fl/build-$v-noasy-$tgt.log" 2>&1 \
          || { tail -20 "$WORK/$fl/build-$v-noasy-$tgt.log"; exit 1; }
        promisify "$T/dist/libav-$V-$v.$tgt.mjs" > "$WORK/tmp.mjs"
        rename "$WORK/tmp.mjs" "$v" "$tgt" "$fl-noasy" "$ext" > "$OUT/libav-$V-$v-$fl-noasy.$tgt.mjs"
        grep -q 'Promise.resolve(ccall' "$OUT/libav-$V-$v-$fl-noasy.$tgt.mjs"
        cp "$T/dist/libav-$V-$v.$ext" "$OUT/libav-$V-$v-$fl-noasy.$tgt.wasm"
      done
    fi
  done
done
ls -la "$OUT"
