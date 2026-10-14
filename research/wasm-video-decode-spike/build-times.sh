#!/usr/bin/env bash
# 拋棄式 spike（#20）：模擬 CI（private repo 的 ubuntu-latest = 2 vCPU）量乾淨 build 的時間。
# 每個組合各用一份全新的 libav.js 樹（含 emfiberthreads、dav1d、FFmpeg 的 configure 與 compile），make -j2、--cpus=2。
# 用法：research/wasm-video-decode-spike/build-times.sh <build.sh 用過的工作目錄（要有 dl/）> <out.tsv> [case...]
#   case：af-wasm、afv-wasm、dav1d-wasm、dav1d-thr、dav1d-wasm+thr
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(cd "$1" && pwd); OUT=$(realpath "$2"); shift 2
[ $# -gt 0 ] || set -- af-wasm afv-wasm dav1d-wasm dav1d-wasm+thr
V=6.10.9.0; IMAGE=kikoeru-libavjs-build:dav1d; C=c05a676d16c1068cce6115594858c50a7ecad4b8
source "$HERE/variants.sh"
[ -f "$OUT" ] || printf "case\tseconds\tjobs\n" > "$OUT"
for c in "$@"; do
  v=kikoeru-${c%%-*}; tg=""
  [[ $c == *wasm* ]] && tg="$tg dist/libav-$V-$v.wasm.mjs"
  [[ $c == *thr* ]] && tg="$tg dist/libav-$V-$v.thr.mjs"
  T="$WORK/bt/$c/libav.js"; rm -rf "$WORK/bt/$c"; mkdir -p "$WORK/bt/$c"
  tar xzf "$WORK/dl/libavjs.tar.gz" -C "$WORK/bt/$c" && mv "$WORK/bt/$c/libav.js-$C" "$T"
  for p in libavjs-accessors avio-accessors codecpar-accessors; do patch -s -d "$T" -p1 -i "$HERE/$p.patch"; done
  mkdir -p "$T/build" && cp "$WORK/dl/"{ffmpeg-*,emfiberthreads-*,dav1d-*} "$T/build/"
  cp -r "$WORK/oz/libav.js/node_modules" "$T/"   # npm ci 不計入時間
  R() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --cpus=2 -v "$T:/work/libav.js" "$IMAGE" bash -c "$1"; }
  R "cd configs && ./mkconfig.js $v '${VARIANTS[$v]}'"
  s=$(date +%s)
  R "make -j2 $tg dist/libav-$V-$v.mjs" > "$WORK/bt/$c.log" 2>&1 || { tail -20 "$WORK/bt/$c.log"; exit 1; }
  printf "%s\t%s\t2\n" "$c" "$(( $(date +%s) - s ))" | tee -a "$OUT"
  rm -rf "$WORK/bt/$c"
done
