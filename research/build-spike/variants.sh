# 拋棄式 spike（#10）：Engine 需要的 libav.js configuration fragments。
# fragment 命名見 libav.js docs/CONFIG.md；沒有實體目錄的 fragment 會直接變成 --enable-<kind>=<name>。

# demuxer：mov(mp4/m4a)、matroska(mkv/mka/webm)、mp3、aac(ADTS)、flac、ogg、wav、wv(WavPack，fragment 一併開 wavpack decoder)、caf
DEMUXERS='"demuxer-mp4","demuxer-matroska","demuxer-mp3","demuxer-aac","demuxer-flac","demuxer-ogg","demuxer-wav","demuxer-wavpack","demuxer-caf"'

# 音訊 decoder 全走 wasm（#5 的結論）。mp3 只開 float 版 mp3float；aac 用 float 版。opus 另外處理（見下）。
DECODERS='"decoder-aac","decoder-mp3float","decoder-alac","decoder-flac","decoder-vorbis",
"decoder-pcm_s16le","decoder-pcm_s16be","decoder-pcm_s24le","decoder-pcm_s24be","decoder-pcm_s32le","decoder-pcm_s32be",
"decoder-pcm_f32le","decoder-pcm_f32be","decoder-pcm_f64le","decoder-pcm_f64be","decoder-pcm_u8","decoder-pcm_s8"'

# FFmpeg 9.0 的原生 opus decoder 依賴 swresample（configure：opus_decoder_deps="swresample"），
# 沒開 swresample 時 configure 會靜默停用它。所以原生 opus 一定要帶 swresample（fragment 也會開 aresample filter）。
OPUS_NATIVE='"decoder-opus","swresample"'
OPUS_LIB='"decoder-libopus"'   # 比較用：libopus 1.6.1（BSD-3-Clause），不需要 swresample

# parser：音訊 seek／封包切分；影片只 demux 給 WebCodecs，不開 video decoder，也不需要任何 bsf
# （mov／matroska 的 H.264／HEVC extradata 本來就是 avcC／hvcC）。
PARSERS='"parser-aac","parser-mpegaudio","parser-flac","parser-opus","parser-vorbis","parser-h264","parser-hevc","parser-vp9","parser-av1"'

# 字幕（ASS/SSA/SRT in mkv、mov_text in mp4）只要 demuxer，不開 subtitle decoder：封包原文直接 passthrough。

BASE="\"avformat\",\"avcodec\",$DEMUXERS,$DECODERS,$PARSERS"
AF='"avfilter","filter-atempo","filter-aformat"'   # abuffer/abuffersink 由 FFmpeg 固定編入

# variant 名稱 → fragments
declare -A VARIANTS=(
  [kikoeru]="[$BASE,$OPUS_NATIVE]"
  [kikoeru-af]="[$BASE,$OPUS_NATIVE,$AF]"          # + libavfilter 與 atempo
  [kikoeru-libopus]="[$BASE,$OPUS_LIB]"            # opus 改用 libopus、拿掉 swresample
  [kikoeru-zlib]="[$BASE,$OPUS_NATIVE,\"zlib\"]"    # + zlib：Matroska ContentCompression(zlib)、mov 的 cmov
)
