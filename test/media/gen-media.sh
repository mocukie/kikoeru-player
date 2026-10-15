#!/usr/bin/env bash
# 產生測試媒體（docs/testing.md「測試媒體」），每個檔案的內容與特徵見 README.md。
# 用法：gen-media.sh [ci|manual]，預設 ci。需要 Docker 與 python3。
# FFmpeg 在釘 digest 的 image 內執行，輸出到 gitignored 的 test/media/out/。
# CI 組產生完才寫入 out/.stamp（兩個 script 的 sha256），scripts/check-media.ts 以它判斷媒體是否存在且是最新的。
set -euo pipefail

FFMPEG_IMAGE=jrottenberg/ffmpeg:7.1-ubuntu@sha256:292a972c60356abd651d9a4f9c808c13e7473f65ad400b7eb99215f4e571931d

set_name=${1:-ci}
case $set_name in
  ci | manual) ;;
  *)
    echo "用法：$0 [ci|manual]" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# host：準備字幕來源，在 container 內重新執行本 script，最後寫入 .stamp。
# ---------------------------------------------------------------------------
if [[ ${KIKOERU_MEDIA_IN_CONTAINER:-} != 1 ]]; then
  here=$(cd "$(dirname "$0")" && pwd)
  out="$here/out"
  mkdir -p "$out"
  if [[ $set_name == ci ]]; then
    rm -rf "$out/.stamp" "$out/.work" "$out/audio" "$out/video" "$out/broken"
    python3 "$here/gen-subs.py" "$out/.work" 20
  else
    rm -rf "$out/manual"
  fi

  docker run --rm -u "$(id -u):$(id -g)" -e KIKOERU_MEDIA_IN_CONTAINER=1 \
    -v "$here:/media:ro" -v "$out:/out" -w /out \
    --entrypoint bash "$FFMPEG_IMAGE" /media/gen-media.sh "$set_name"

  if [[ $set_name == ci ]]; then
    rm -rf "$out/.work"
    if command -v sha256sum > /dev/null; then sha256=(sha256sum); else sha256=(shasum -a 256); fi
    (cd "$here" && "${sha256[@]}" gen-media.sh gen-subs.py) > "$out/.stamp"
  fi
  echo "測試媒體（$set_name）已產生於 $out"
  exit 0
fi

# ---------------------------------------------------------------------------
# container：以下都在 /out 內執行 FFmpeg。
# ---------------------------------------------------------------------------
# SVT-AV1 的 log 不受 -loglevel 控制。
export SVT_LOG=1
ff() { ffmpeg -hide_banner -loglevel error -nostdin -y "$@"; }

# beep <秒數> <取樣率> <channel layout> <各聲道的基準頻率…>
# 每整秒開始的 0.1 秒是正弦波 beep（振幅 0.5），其餘為靜音；每 10 秒的那一聲（0 s、10 s…）頻率加倍。
# 相位從整秒起算，beep 起點落在 sample index 為取樣率整數倍的位置。
beep() {
  local dur=$1 rate=$2 layout=$3 f
  shift 3
  local exprs=()
  for f in "$@"; do
    exprs+=("if(lt(mod(t\,1)\,0.1)\,0.5*sin(2*PI*$f*if(lt(mod(t\,10)\,1)\,2\,1)*t)\,0)")
  done
  local IFS='|'
  echo "aevalsrc=exprs='${exprs[*]}':s=$rate:c=$layout:d=$dur"
}
stereo() { beep "$1" 48000 stereo "$2" "$2"; } # stereo <秒數> <基準頻率>

# video <秒數> <寬> <高>：30 fps 的 testsrc；左上 64×64 平時是黑色，與 beep 同時變白（每整秒開始的 3 個 frame，即 0.1 秒）。
# 以 frame 編號判斷，避免時間的浮點誤差多亮一個 frame。
video() {
  echo "testsrc=size=$2x$3:rate=30:d=$1,drawbox=x=0:y=0:w=64:h=64:color=black:t=fill,drawbox=x=0:y=0:w=64:h=64:color=white:t=fill:enable='lt(mod(n\,30)\,3)',format=yuv420p"
}
h264=(-c:v libx264 -preset veryfast -g 30)

if [[ $set_name == manual ]]; then
  mkdir -p manual
  ff -f lavfi -i "$(stereo 2700 880)" -c:a libmp3lame -b:a 128k manual/long-45min.mp3
  ff -f lavfi -i "$(stereo 2400 880)" -c:a pcm_s24le manual/long-40min-s24.wav
  # 以 CBR 加 filler 撐出 1.5 GB 左右的大小。
  ff -f lavfi -i "$(video 1800 1280 720)" -f lavfi -i "$(stereo 1800 880)" \
    -c:v libx264 -preset ultrafast -g 30 -b:v 6500k -minrate 6500k -maxrate 6500k -bufsize 6500k \
    -x264-params nal-hrd=cbr -c:a aac -b:a 128k manual/long-30min-720p.mkv
  exit 0
fi

mkdir -p audio video broken

# --- 音訊：10 秒，48 kHz stereo，880 Hz ---
audio_src="$(stereo 10 880)"
ff -f lavfi -i "$audio_src" -c:a libmp3lame -b:a 192k audio/mp3.mp3
ff -f lavfi -i "$audio_src" -c:a aac -b:a 192k -movflags +faststart audio/aac.m4a
ff -f lavfi -i "$audio_src" -c:a aac -b:a 192k -f adts audio/aac-adts.aac
ff -f lavfi -i "$audio_src" -c:a alac audio/alac.m4a
ff -f lavfi -i "$audio_src" -c:a libopus -b:a 128k audio/opus.opus
ff -f lavfi -i "$audio_src" -c:a libvorbis -q:a 4 audio/vorbis.ogg
ff -f lavfi -i "$audio_src" -c:a flac audio/flac.flac
ff -f lavfi -i "$audio_src" -c:a wavpack audio/wavpack.wv
for fmt in s16 s24 s32 f32 f64; do
  ff -f lavfi -i "$audio_src" -c:a "pcm_${fmt}le" "audio/pcm-$fmt.wav"
done
ff -f lavfi -i "$audio_src" -c:a pcm_u8 audio/pcm-u8.wav
ff -f lavfi -i "$audio_src" -c:a pcm_s16be audio/pcm-s16be.aiff
ff -f lavfi -i "$audio_src" -c:a ac3 -b:a 192k audio/ac3.ac3
ff -f lavfi -i "$audio_src" -c:a eac3 -b:a 192k audio/eac3.eac3
for rate in 44100 96000 192000; do
  ff -f lavfi -i "$(beep 10 "$rate" stereo 880 880)" -c:a flac "audio/flac-$rate.flac"
done
# 5.1：各聲道的基準頻率不同，用來確認聲道對應與 downmix。
ff -f lavfi -i "$(beep 10 48000 5.1 440 550 660 110 770 880)" -c:a flac audio/flac-5.1.flac

# --- 影片：10 秒，320×180，30 fps，keyframe 間隔 1 秒 ---
video_src="$(video 10 320 180)"
ff -f lavfi -i "$video_src" -f lavfi -i "$audio_src" "${h264[@]}" -c:a aac -b:a 128k -movflags +faststart video/h264-aac.mp4
ff -f lavfi -i "$video_src" -f lavfi -i "$audio_src" -c:v libvpx-vp9 -b:v 0 -crf 40 -deadline realtime -cpu-used 8 -g 30 \
  -c:a libopus -b:a 96k video/vp9-opus.webm
ff -f lavfi -i "$video_src" -f lavfi -i "$audio_src" -c:v libsvtav1 -preset 10 -crf 45 -g 30 -svtav1-params enable-overlays=0 \
  -c:a libopus -b:a 96k video/av1-opus.webm
ff -f lavfi -i "$video_src" -f lavfi -i "$audio_src" -c:v libx265 -preset ultrafast -x265-params log-level=error:keyint=30:pools=none -tag:v hvc1 \
  -c:a aac -b:a 128k -movflags +faststart video/hevc-aac.mp4
# AVI 不適合 B-frame。
ff -f lavfi -i "$video_src" -f lavfi -i "$audio_src" "${h264[@]}" -bf 0 -c:a libmp3lame -b:a 128k video/h264-mp3.avi
# 只改 display matrix，不動畫面內容。
ff -display_rotation 90 -i video/h264-aac.mp4 -c copy -movflags +faststart video/rotated-90.mp4

# 多音軌與多字幕軌：20 秒；字幕來源由 gen-subs.py 產生在 .work/。
ff -f lavfi -i "$(video 20 320 180)" -f lavfi -i "$(stereo 20 880)" -f lavfi -i "$(stereo 20 440)" \
  -i .work/embedded-ja.srt -i .work/embedded-zh.ass \
  -map 0:v -map 1:a -map 2:a -map 3 -map 4 \
  "${h264[@]}" -c:a:0 aac -b:a:0 128k -c:a:1 libopus -b:a:1 96k -c:s:0 srt -c:s:1 ass \
  -metadata:s:a:0 language=jpn -metadata:s:a:0 title="beep 880 Hz" \
  -metadata:s:a:1 language=chi -metadata:s:a:1 title="beep 440 Hz" \
  -metadata:s:s:0 language=jpn -metadata:s:s:1 language=chi \
  video/multi-track.mkv
# 外掛音軌：與 multi-track.mkv 同長，440 Hz。
ff -f lavfi -i "$(stereo 20 440)" -c:a flac video/external-audio-440.flac

# --- 壞檔 ---
half() { head -c "$(($(wc -c < "$1") / 2))" "$1" > "$2"; } # half <來源> <輸出>：只留前一半的 bytes
half audio/mp3.mp3 broken/truncated.mp3
half video/h264-aac.mp4 broken/truncated.mp4
# 4–6 秒的封包約每 16 個 byte 改壞一個。
noise="noise=amount=if(between(pts*tb\,4\,6)\,16\,0)"
ff -i audio/mp3.mp3 -c copy -bsf:a "$noise" broken/bad-packets.mp3
ff -i video/h264-aac.mp4 -c copy -bsf:v "$noise" broken/bad-packets.mkv
cp audio/flac.flac broken/fake-ext-flac.mp3
cp video/vp9-opus.webm broken/fake-ext-webm.mp4
