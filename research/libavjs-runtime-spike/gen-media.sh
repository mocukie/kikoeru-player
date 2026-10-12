#!/usr/bin/env bash
# 拋棄式 spike（#17）：產生實測用媒體（不進 git）。用 Docker 內的 ffmpeg 7.1。
# 用法：research/libavjs-runtime-spike/gen-media.sh <輸出目錄>
set -euo pipefail
M=$(mkdir -p "$1" && cd "$1" && pwd)
R="docker run --rm -u $(id -u):$(id -g) -v $M:/m -w /m jrottenberg/ffmpeg:7.1-ubuntu -hide_banner -loglevel error -y"
# 有內容的音訊（正弦 + 雜訊），避免 encoder 把靜音壓到幾乎沒有資料
A="sine=f=440:r=48000:d=DUR,aformat=channel_layouts=stereo[s];anoisesrc=a=0.05:r=48000:d=DUR,aformat=channel_layouts=stereo[n];[s][n]amix=inputs=2"
a() { echo "${A//DUR/$1}"; }

# abort／seek 測試：60 秒，四種容器
$R -f lavfi -i testsrc2=size=640x360:rate=30:duration=60 -filter_complex "$(a 60)" \
   -c:v libx264 -preset veryfast -g 60 -b:v 1500k -c:a aac -b:a 128k ab.mkv
$R -f lavfi -i testsrc2=size=640x360:rate=30:duration=60 -filter_complex "$(a 60)" \
   -c:v libx264 -preset veryfast -g 60 -b:v 1500k -c:a aac -b:a 128k ab.mp4
$R -filter_complex "$(a 60)" -c:a pcm_s16le ab.wav
$R -filter_complex "$(a 60)" -c:a libmp3lame -b:a 192k ab.mp3

# Asyncify 速度：300 秒純音訊
$R -filter_complex "$(a 300)" -c:a libmp3lame -b:a 192k sp.mp3
$R -filter_complex "$(a 300)" -c:a aac -b:a 192k sp.m4a
$R -filter_complex "$(a 300)" -c:a flac sp.flac
$R -filter_complex "$(a 300)" -c:a libopus -b:a 128k sp.opus
$R -filter_complex "$(a 300)" -c:a pcm_s24le sp.wav

# 多 instance：主檔（影片＋音訊）與外掛音軌
$R -filter_complex "$(a 120)" -c:a libmp3lame -b:a 192k ext.mp3

# WebCodecs：H.264 Annex B 原始串流（每個 access unit 以 AUD 開頭），720p 與 1080p
for s in 1280x720 1920x1080; do
  $R -f lavfi -i testsrc2=size=$s:rate=30:duration=10 -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p \
     -g 30 -bf 0 -x264-params aud=1 -f h264 v$s.h264
done
ls -la "$M"
