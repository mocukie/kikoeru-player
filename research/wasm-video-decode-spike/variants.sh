# 拋棄式 spike（#20）：variant 的 fragment 清單。kikoeru-af 依 ADR-0003 的內容（#10 的清單加上 avi、aiff、ac3、eac3）。

DEMUXERS='"demuxer-mp4","demuxer-matroska","demuxer-mp3","demuxer-aac","demuxer-flac","demuxer-ogg","demuxer-wav","demuxer-wavpack","demuxer-caf","demuxer-avi","demuxer-aiff"'
DECODERS='"decoder-aac","decoder-mp3float","decoder-alac","decoder-flac","decoder-vorbis","decoder-ac3","decoder-eac3",
"decoder-pcm_s16le","decoder-pcm_s16be","decoder-pcm_s24le","decoder-pcm_s24be","decoder-pcm_s32le","decoder-pcm_s32be",
"decoder-pcm_f32le","decoder-pcm_f32be","decoder-pcm_f64le","decoder-pcm_f64be","decoder-pcm_u8","decoder-pcm_s8"'
OPUS_NATIVE='"decoder-opus","swresample"'
PARSERS='"parser-aac","parser-mpegaudio","parser-flac","parser-opus","parser-vorbis","parser-ac3","parser-h264","parser-hevc","parser-vp9","parser-av1"'
AF='"avfilter","filter-atempo","filter-aformat"'
BASE="\"avformat\",\"avcodec\",$DEMUXERS,$DECODERS,$PARSERS,$OPUS_NATIVE,$AF"

# decoder-libdav1d 是 libav.js c05a676 的 fragment（PR #108）：--enable-libdav1d、--enable-decoder=libdav1d，
# 另外帶 av1_metadata、extract_extradata 兩個 bsf（fragment 自帶，不是我們要的）。
declare -A VARIANTS=(
  [kikoeru-af]="[$BASE]"                                   # 現行主 variant（ADR-0003）
  [kikoeru-afv]="[$BASE,\"decoder-libdav1d\"]"             # 選項 A：dav1d 放進主 variant
  [kikoeru-dav1d]='["avcodec","decoder-libdav1d"]'         # 選項 B：只在需要時載入的獨立 wasm（只有 avcodec＋dav1d）
)
