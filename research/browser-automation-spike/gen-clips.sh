#!/usr/bin/env bash
# 產生探測用的極小影片（各 30 frame、320x240），輸出到 site/；檔案不進 git。
# 原始探測時的 clip 由 ffmpeg 7.1 產生，參數依報告重建。
set -euo pipefail
cd "$(dirname "$0")/site"
ff() { docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/w" -w /w jrottenberg/ffmpeg:7.1-ubuntu -hide_banner -loglevel error -y "$@"; }
src=(-f lavfi -i testsrc=size=320x240:rate=30:d=1)
ff "${src[@]}" -c:v libx264 -profile:v high -level 3.1 -pix_fmt yuv420p -g 30 -bsf:v h264_mp4toannexb -f h264 h264.264
ff "${src[@]}" -c:v libvpx-vp9 -g 30 -f ivf vp9.ivf
ff "${src[@]}" -c:v libaom-av1 -cpu-used 8 -g 30 -f ivf av1.ivf
