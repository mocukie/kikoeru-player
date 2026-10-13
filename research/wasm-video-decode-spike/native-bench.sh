#!/usr/bin/env bash
# 拋棄式 spike（#20）：原生 dav1d 1.5.4 的對照組（同一台機器、同一批媒體）。
#   asm：x86 AVX2 等手寫組語（原生的實際速度）；c：--cpumask 0，只用 C（與 wasm 同樣沒有手寫 SIMD）。
# 用法：research/wasm-video-decode-spike/native-bench.sh <build-dir 的工作目錄（含 dl/dav1d-*.tar.bz2）> <media> <out.tsv> [threads...]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(cd "$1" && pwd); MEDIA=$(cd "$2" && pwd); OUT=$(realpath "$3"); shift 3
[ $# -gt 0 ] || set -- 1
IMAGE=kikoeru-libavjs-build:dav1d
docker build -q -t "$IMAGE" "$HERE" >/dev/null
N="$WORK/native"; mkdir -p "$N"
[ -d "$N/dav1d-1.5.4" ] || tar xjf "$WORK/dl/dav1d-1.5.4.tar.bz2" -C "$N"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$N:/n" -w /n/dav1d-1.5.4 "$IMAGE" bash -c \
  'test -x build/tools/dav1d || (meson setup build --buildtype release -Denable_tests=false >/dev/null && ninja -C build >/dev/null)'
# mp4 → ivf（dav1d CLI 不讀 mp4）
mkdir -p "$N/ivf"
for f in "$MEDIA"/*.mp4; do
  b=$(basename "$f" .mp4); [ -f "$N/ivf/$b.ivf" ] && continue
  docker run --rm -u "$(id -u):$(id -g)" -v "$MEDIA:/m:ro" -v "$N/ivf:/o" jrottenberg/ffmpeg:7.1-ubuntu -hide_banner -loglevel error -y -i "/m/$b.mp4" -c copy -f ivf "/o/$b.ivf"
done
printf "file\tmode\tthreads\tfps\n" > "$OUT"
for f in "$N"/ivf/*.ivf; do
  b=$(basename "$f" .ivf)
  for t in "$@"; do
    for mode in asm c; do
      mask=$([ $mode = c ] && echo "--cpumask 0" || echo "")
      fps=$(docker run --rm -v "$N:/n:ro" "$IMAGE" /n/dav1d-1.5.4/build/tools/dav1d -i "/n/ivf/$b.ivf" -o /dev/null --muxer null \
        --threads "$t" $mask 2>&1 | tr '\r' '\n' | grep -o '[0-9.]*/[0-9.]* fps' | tail -1 | cut -d/ -f1)
      printf "%s\t%s\t%s\t%s\n" "$b" "$mode" "$t" "$fps" | tee -a "$OUT"
    done
  done
done
