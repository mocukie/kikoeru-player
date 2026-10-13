#!/usr/bin/env bash
# 拋棄式 spike（#20）：產生 AV1 測試媒體（不進 git）。
# 來源：Blender 開放影片（CC BY 3.0）Big Buck Bunny 1080p30（動畫）與 Tears of Steel 1080p（實拍＋CG，1920×800 24fps）。
# 編碼：jrottenberg/ffmpeg:7.1 的 libaom-av1（good、cpu-used 6、row-mt、GOP 4 秒），1-pass VBR 目標 bitrate，MP4 容器。
# 用法：research/wasm-video-decode-spike/gen-media.sh <輸出目錄>
set -euo pipefail
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
SRC="$OUT/src"; mkdir -p "$SRC"
IMG=jrottenberg/ffmpeg:7.1-ubuntu

fetch() { # url zip sha256 member
  [ -f "$SRC/$4" ] && return
  [ -f "$SRC/$2" ] || curl -sSfL "$1" -o "$SRC/$2"
  echo "$3  $SRC/$2" | sha256sum -c --quiet -
  (cd "$SRC" && unzip -o -q "$2" "$4")
}
fetch https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip bbb.zip \
  e320fef389ec749117d0c1583945039266a40f25483881c2ff0d33207e62b362 bbb_sunflower_1080p_30fps_normal.mp4
fetch https://download.blender.org/demo/movies/ToS/tears_of_steel_1080p.mov.zip tos.zip \
  d87a41de040d3814dbde143e9ab85ef122caf22265f660b0bebf476cd8b357a5 tears_of_steel_1080p.mov

ff() { docker run --rm -u "$(id -u):$(id -g)" -v "$OUT:/m" "$IMG" -hide_banner -loglevel error -y "$@"; }

# enc <名稱> <來源> <起點秒> <長度秒> <寬> <高> <fps> <pix_fmt> <bitrate> [額外參數...]
enc() {
  local name=$1 src=$2 ss=$3 t=$4 w=$5 h=$6 fps=$7 pf=$8 br=$9; shift 9
  [ -f "$OUT/$name.mp4" ] && return
  local s=$(date +%s)
  ff -ss "$ss" -t "$t" -i "/m/src/$src" -an -vf "scale=$w:$h:flags=lanczos,format=$pf" -r "$fps" \
    -c:v libaom-av1 -usage good -cpu-used 6 -row-mt 1 -threads 32 -b:v "$br" -g $((fps * 4)) "$@" \
    -movflags +faststart "/m/$name.mp4"
  echo "$name: $(( $(date +%s) - s ))s $(stat -c %s "$OUT/$name.mp4") bytes"
}

B=bbb_sunflower_1080p_30fps_normal.mp4
T=tears_of_steel_1080p.mov
# 主矩陣：BBB（動畫），20 秒，1080p／720p × 8／10-bit × 一般／高 bitrate
enc bbb-1080-8-2M   $B 60 20 1920 1080 30 yuv420p     2M
enc bbb-1080-8-6M   $B 60 20 1920 1080 30 yuv420p     6M
enc bbb-1080-10-2M  $B 60 20 1920 1080 30 yuv420p10le 2M
enc bbb-1080-10-6M  $B 60 20 1920 1080 30 yuv420p10le 6M
enc bbb-720-8-1M    $B 60 20 1280 720  30 yuv420p     1M
enc bbb-720-8-3M    $B 60 20 1280 720  30 yuv420p     3M
enc bbb-720-10-1M   $B 60 20 1280 720  30 yuv420p10le 1M
enc bbb-720-10-3M   $B 60 20 1280 720  30 yuv420p10le 3M
# 實拍（ToS 是 2.4:1，畫面 1920×800 與 1280×534，24fps）
enc tos-800-8-3M    $T 480 20 1920 800 24 yuv420p     3M
enc tos-800-10-3M   $T 480 20 1920 800 24 yuv420p10le 3M
enc tos-534-8-1.5M  $T 480 20 1280 534 24 yuv420p     1.5M
# 變化：2x2 tiles（tile thread 的效果）、film grain synthesis（dav1d 要多做 grain 合成）
enc bbb-1080-8-2M-tiles $B 60 20 1920 1080 30 yuv420p 2M -tiles 2x2
enc tos-800-8-3M-grain  $T 480 20 1920 800 24 yuv420p 3M -denoise-noise-level 10
# 很小的 fixture（VideoFrame 測試、smoke 用）
enc tiny-8   $B 60 2 320 180 30 yuv420p     200k
enc tiny-10  $B 60 2 320 180 30 yuv420p10le 200k
ls -la "$OUT"
