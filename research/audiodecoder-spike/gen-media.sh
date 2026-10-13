#!/usr/bin/env bash
# 拋棄式 spike（#18）：產生 AudioDecoder 評估用的媒體（不進 git）。用 Docker 內的 ffmpeg 7.1（含 libmp3lame、libopus、libvorbis、libfdk_aac）。
# 用法：research/audiodecoder-spike/gen-media.sh <輸出目錄>
set -euo pipefail
M=$(mkdir -p "$1" && cd "$1" && pwd)
R="docker run --rm -u $(id -u):$(id -g) -v $M:/m -w /m jrottenberg/ffmpeg:7.1-ubuntu -hide_banner -loglevel error -y"

# 對齊用訊號：左右聲道不同、頻率緩慢調變的正弦（都在 4 kHz 以下，lossy codec 也保留得住）加固定 seed 的雜訊（cross-correlation 只有一個峰）。
# 長度刻意不是任何 codec frame 長度的整數倍，才看得出 trailing padding 有沒有裁掉。
sig() { # 長度 取樣率
  echo "aevalsrc=0.3*sin(2*PI*440*t+30*sin(2*PI*0.7*t))+0.15*sin(2*PI*2500*t+50*sin(2*PI*0.31*t))|0.3*sin(2*PI*330*t+25*sin(2*PI*0.53*t))+0.15*sin(2*PI*3700*t+40*sin(2*PI*0.23*t)):s=$2:d=$1,aformat=channel_layouts=stereo[s];anoisesrc=a=0.03:r=$2:d=$1:seed=1,aformat=channel_layouts=stereo[n];[s][n]amix=inputs=2:normalize=0"
}
A48=$(sig 20.0123 48000)
A44=$(sig 20.0123 44100)

# --- 取樣精準度：每種 codec／容器一個 20 秒檔 ---
$R -filter_complex "$A48" -c:a aac -b:a 160k acc-aac.m4a                       # FFmpeg aac，mp4 edit list（priming 1024）
$R -filter_complex "$A48" -c:a aac -b:a 160k -f adts acc-aac.aac               # ADTS，沒有任何 priming 資訊
$R -filter_complex "$A48" -c:a libfdk_aac -b:a 160k acc-fdk.m4a                # fdk-aac（另一個 encoder 的 edit list）
$R -filter_complex "$A44" -c:a libmp3lame -b:a 192k acc-mp3.mp3               # LAME，有 Xing／LAME header（delay／padding）
$R -filter_complex "$A44" -c:a libmp3lame -b:a 192k -write_xing 0 acc-mp3-noxing.mp3  # 沒有 LAME header
$R -filter_complex "$A48" -c:a libopus -b:a 128k acc-opus.opus                 # Ogg Opus（pre-skip 312）
$R -filter_complex "$A48" -c:a libopus -b:a 128k acc-opus.webm                 # WebM Opus（CodecDelay、DiscardPadding）
$R -filter_complex "$A48" -c:a flac acc-flac.flac                             # 48k 的基準（無失真、沒有 delay）
$R -filter_complex "$A44" -c:a flac acc-flac44.flac                           # 44.1k（MP3）的基準
$R -filter_complex "$A48" -c:a libvorbis -q:a 5 acc-vorbis.ogg
$R -filter_complex "$A48" -c:a libvorbis -q:a 5 acc-vorbis.webm

# --- CPU：48k／16-bit 300 秒，192k／24-bit 60 秒 ---
L48=$(sig 300 48000)
L192=$(sig 60 192000)   # 192k 檔 60 秒就好（整個放進 MEMFS，300 秒的 WAV 有 345 MB）
$R -filter_complex "$L48" -c:a libmp3lame -b:a 192k cpu-mp3.mp3
$R -filter_complex "$L48" -c:a aac -b:a 192k cpu-aac.m4a
$R -filter_complex "$L48" -c:a libopus -b:a 128k cpu-opus.opus
$R -filter_complex "$L48" -c:a libvorbis -q:a 5 cpu-vorbis.ogg
$R -filter_complex "$L48" -c:a flac cpu-flac.flac
$R -filter_complex "$L192" -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 cpu-flac192.flac
$R -filter_complex "$L192" -c:a pcm_s24le cpu-pcm192.wav

# --- isConfigSupported 誤報檢查：各種取樣率／聲道數的短檔（3 秒） ---
S6="aevalsrc=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*550*t)|0.3*sin(2*PI*660*t)|0.1*sin(2*PI*60*t)|0.3*sin(2*PI*770*t)|0.3*sin(2*PI*880*t):s=48000:d=3:c=5.1"
s() { echo "aevalsrc=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*550*t):s=$1:d=3:c=stereo"; }
$R -filter_complex "$S6" -c:a aac -b:a 384k cs-aac-6ch.m4a
$R -filter_complex "$(s 96000)" -c:a aac -b:a 256k cs-aac-96k.m4a
$R -filter_complex "$S6" -c:a libopus -b:a 256k cs-opus-6ch.opus
$R -filter_complex "$S6" -c:a flac cs-flac-6ch.flac
$R -filter_complex "$(s 192000)" -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 cs-flac-192k24.flac
$R -filter_complex "$(s 384000)" -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 cs-flac-384k24.flac
$R -filter_complex "$S6" -c:a libvorbis -q:a 5 cs-vorbis-6ch.ogg
$R -filter_complex "$(s 22050)" -ac 1 -c:a libmp3lame -b:a 64k cs-mp3-22k-mono.mp3
$R -filter_complex "$(s 8000)" -ac 1 -c:a libmp3lame -b:a 16k cs-mp3-8k-mono.mp3
$R -filter_complex "$S6" -c:a ac3 -b:a 448k cs-ac3-6ch.ac3
$R -filter_complex "$S6" -c:a eac3 -b:a 384k cs-eac3-6ch.eac3
$R -filter_complex "$(s 48000)" -c:a alac cs-alac.m4a
$R -filter_complex "$(s 96000)" -c:a pcm_s24le cs-pcm-s24-96k.wav
$R -filter_complex "$(s 48000)" -c:a pcm_f32le cs-pcm-f32.wav
ls -la "$M"
