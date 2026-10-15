#!/usr/bin/env bash
# build libav.js 的自訂 variant，產出 wasm Release 的全部內容（ADR-0005）。
# 平常經由 pnpm wasm:build（scripts/wasm-build.ts）執行：它決定 tag、在本 script 之後做 LGPL 檢查，再把產物放進 wasm/dist/。
# 用法：wasm/build.sh <Release tag> <Release 的 URL>；JOBS=<n> 可限制 make 的平行數與 container 的 CPU。
# 需要 Docker。工作目錄是 gitignored 的 wasm/.work/：
#   downloads/  上游 tarball（CI 快取這個目錄）
#   libav.js/   每次重新 clone 的 libav.js 與 build 中間產物
#   release/    Release 的全部檔案：dist 檔案、sources.tar、NOTICE、LGPL-2.1.txt、SHA256SUMS
#   config.h    FFmpeg configure 的結果，供 LGPL 檢查
set -euo pipefail

FFMPEG_IMAGE=jrottenberg/ffmpeg:7.1-ubuntu@sha256:292a972c60356abd651d9a4f9c808c13e7473f65ad400b7eb99215f4e571931d
BUILD_IMAGE=kikoeru-player-wasm-build

if [[ $# -ne 2 ]]; then
  echo "用法：$0 <Release tag> <Release 的 URL>" >&2
  exit 2
fi
tag=$1
release_url=$2

# ---------------------------------------------------------------------------
# host：build image、產生 smoke test 的媒體，再以 container 重新執行本 script。
# ---------------------------------------------------------------------------
if [[ ${KIKOERU_WASM_IN_CONTAINER:-} != 1 ]]; then
  here=$(cd "$(dirname "$0")" && pwd)
  work="$here/.work"
  mkdir -p "$work"

  # 以 stdin 傳 Dockerfile，不把 wasm/.work/ 當成 build context 送出。
  docker build --quiet -t "$BUILD_IMAGE" - < "$here/Dockerfile" > /dev/null

  # smoke test 的媒體：每個檔案 1 秒、48 kHz stereo，涵蓋 variant 的每個 demuxer 與音訊 decoder。
  rm -rf "$work/smoke-media"
  mkdir -p "$work/smoke-media"
  docker run --rm -u "$(id -u):$(id -g)" -v "$work/smoke-media:/out" -w /out --entrypoint bash "$FFMPEG_IMAGE" -c '
    set -euo pipefail
    ff() { ffmpeg -hide_banner -loglevel error -nostdin -y "$@"; }
    sine() { echo "sine=frequency=$1:sample_rate=48000:duration=1,aformat=channel_layouts=stereo"; }
    a=$(sine 880)
    ff -f lavfi -i "$a" -c:a libmp3lame mp3.mp3
    ff -f lavfi -i "$a" -c:a aac aac.m4a
    ff -f lavfi -i "$a" -c:a aac -f adts aac-adts.aac
    ff -f lavfi -i "$a" -c:a alac alac.caf
    ff -f lavfi -i "$a" -c:a libopus opus.opus
    ff -f lavfi -i "$a" -c:a libvorbis vorbis.ogg
    ff -f lavfi -i "$a" -c:a flac flac.flac
    ff -f lavfi -i "$a" -c:a wavpack wavpack.wv
    ff -f lavfi -i "$a" -c:a pcm_s24le pcm-s24.wav
    ff -f lavfi -i "$a" -c:a pcm_f64le pcm-f64.wav
    ff -f lavfi -i "$a" -c:a pcm_u8 pcm-u8.wav
    ff -f lavfi -i "$a" -c:a pcm_s16be pcm-s16be.aiff
    ff -f lavfi -i "$a" -c:a ac3 ac3.ac3
    ff -f lavfi -i "$a" -c:a eac3 eac3.eac3
    ff -f lavfi -i "$a" -c:a libmp3lame mp3.avi
    # disposition 與 start_time 的 accessor：第 1 軌 default、第 2 軌 forced，容器時間從 1 秒開始。
    ff -f lavfi -i "$a" -f lavfi -i "$(sine 440)" -map 0 -map 1 -c:a:0 libopus -c:a:1 aac \
      -disposition:a:0 default -disposition:a:1 forced -output_ts_offset 1 multi.mka
  '

  tty=()
  [[ -t 0 && -t 1 ]] && tty=(-t)
  exec docker run --rm ${tty[@]+"${tty[@]}"} ${JOBS:+--cpus="$JOBS"} \
    -u "$(id -u):$(id -g)" -e HOME=/tmp -e KIKOERU_WASM_IN_CONTAINER=1 -e JOBS \
    -v "$here:/wasm" -w /wasm "$BUILD_IMAGE" bash build.sh "$tag" "$release_url"
fi

# ---------------------------------------------------------------------------
# container：以下都在 /wasm（本目錄）內執行。
# ---------------------------------------------------------------------------
# shellcheck source=versions.env
source versions.env
work=/wasm/.work
downloads="$work/downloads"
src="$work/libav.js"
release="$work/release"
name="libav-$LIBAVJS_VERSION-$VARIANT"
log() { echo "[wasm] $*" >&2; }

# 1. 上游 tarball：先下載並核對 sha256，放進 build/ 後 libav.js 的 Makefile 就不會自己下載（它不驗證）。
mkdir -p "$downloads"
fetch() { # fetch <URL> <檔名> <sha256>
  if [[ ! -f $downloads/$2 ]]; then
    log "下載 $2"
    curl -sSfL "$1" -o "$downloads/$2.tmp"
    mv "$downloads/$2.tmp" "$downloads/$2"
  fi
  echo "$3  $downloads/$2" | sha256sum -c --quiet - || {
    echo "$2 的 sha256 與 versions.env 不符。" >&2
    exit 1
  }
}
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"
fetch "https://github.com/Yahweasel/emfiberthreads/archive/refs/tags/v$EMFT_VERSION.tar.gz" \
  "emfiberthreads-$EMFT_VERSION.tar.gz" "$EMFT_SHA256"

# 2. libav.js：每次重新 clone，釘 tag 並核對 commit。用 git clone 而不是 tarball，
#    因為產物開頭的 license header 以 git describe 寫入 libav.js 的版本。
log "clone libav.js v$LIBAVJS_VERSION"
rm -rf "$src" "$release" "$work/config.h"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$LIBAVJS_VERSION" https://github.com/Yahweasel/libav.js "$src"
if [[ $(git -C "$src" rev-parse HEAD) != "$LIBAVJS_COMMIT" ]]; then
  echo "libav.js 的 tag v$LIBAVJS_VERSION 不是 versions.env 的 commit $LIBAVJS_COMMIT。" >&2
  exit 1
fi
for patch in patches/*.patch; do
  patch --quiet -d "$src" -p1 < "$patch"
done
cp -R fragments/. "$src/configs/fragments/"
mkdir -p "$src/build"
cp "$downloads/ffmpeg-$FFMPEG_VERSION.tar.xz" "$downloads/emfiberthreads-$EMFT_VERSION.tar.gz" "$src/build/"

# 3. build：只 build 需要的 target；make build-<variant> 會連 asm.js、threads、debug 一起 build。
fragments=$(sed 's/#.*//' fragments.txt | awk 'NF { printf "%s\"%s\"", (n++ ? "," : "["), $1 } END { print "]" }')
log "variant $VARIANT：$fragments"
(
  cd "$src"
  npm ci --silent --no-audit --no-fund
  (cd configs && ./mkconfig.js "$VARIANT" "$fragments")
  log "make（約需數分鐘）"
  make -j"${JOBS:-$(nproc)}" "dist/$name.wasm.mjs" "dist/$name.mjs" dist/libav.types.d.ts > "$work/make.log" 2>&1 || {
    tail -40 "$work/make.log" >&2
    exit 1
  }
)
cp "$src/build/ffmpeg-$FFMPEG_VERSION/build-base-$VARIANT/config.h" "$work/config.h"

# 4. smoke test：在 Node 以 noworker 載入產物，demux 並解碼 host 產生的媒體。
log 'smoke test'
node smoke.mjs "$src/dist" "$name" "$work/smoke-media"

# 5. Release 的內容。
mkdir -p "$release"
for file in "$name.wasm.wasm" "$name.wasm.mjs" "$name.mjs" libav.types.d.ts; do
  cp "$src/dist/$file" "$release/"
done
cp "$src/build/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$release/LGPL-2.1.txt"
cat > "$release/NOTICE" << EOF
kikoeru-player wasm ($tag)

This software uses code of FFmpeg (https://ffmpeg.org/) licensed under the
GNU Lesser General Public License version 2.1 or later. The full text of the
license is in LGPL-2.1.txt. FFmpeg is compiled to WebAssembly with libav.js
(https://github.com/Yahweasel/libav.js, 0BSD).

The complete corresponding source code (FFmpeg, libav.js, emfiberthreads, the
patches, the configuration and the build scripts) is sources.tar in:
$release_url

The license header at the top of $name.wasm.mjs lists the licenses of all
code compiled into $name.wasm.wasm.
EOF

# sources.tar：LGPL-2.1 §6 的對應原始碼。以固定的 mtime、owner 與檔案順序打包，內容相同時 bytes 也相同。
staging="$work/sources"
rm -rf "$staging"
mkdir -p "$staging/sources/wasm"
cp "$downloads/ffmpeg-$FFMPEG_VERSION.tar.xz" "$downloads/emfiberthreads-$EMFT_VERSION.tar.gz" "$staging/sources/"
git -C "$src" archive --format=tar --prefix="libav.js-$LIBAVJS_VERSION/" HEAD | gzip -n > "$staging/sources/libav.js-$LIBAVJS_VERSION.tar.gz"
# wasm/ 本身（Dockerfile、版本、fragment、patch、build script），不含 gitignored 的 .work/ 與 dist/。
find . -mindepth 1 -maxdepth 1 ! -name .work ! -name dist -exec cp -R {} "$staging/sources/wasm/" \;
sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' "$work/config.h" > "$staging/sources/ffmpeg-configuration.txt"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=u+rw,go=rX --format=gnu \
  -C "$staging" -cf "$release/sources.tar" sources
rm -rf "$staging"

(cd "$release" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\n' | LC_ALL=C sort | xargs sha256sum) > "$work/SHA256SUMS"
mv "$work/SHA256SUMS" "$release/SHA256SUMS"
log "完成：$release"
