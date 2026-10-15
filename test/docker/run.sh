#!/usr/bin/env bash
# 在 Playwright 官方 image 內執行指令，pnpm verify:docker 與 CI 的 browser job 都經過這裡（docs/testing.md「本機與 CI」）。
# 用法：test/docker/run.sh <指令…>，例如 test/docker/run.sh pnpm test:browser
# - repo 掛在 /work，以 host 的 uid／gid 執行，產物的擁有者與 host 相同。
# - node_modules 改掛 .docker-cache/node_modules，在 container 內安裝，不碰 host 的 node_modules。
# - pnpm store 放在 host 的 ~/.cache/kikoeru-player/docker-pnpm-store，CI 快取這個目錄。
set -euo pipefail

# ---------------------------------------------------------------------------
# container：安裝依賴、起 PulseAudio，再執行指令。
# ---------------------------------------------------------------------------
if [[ ${KIKOERU_IN_CONTAINER:-} == 1 ]]; then
  mkdir -p "$HOME" "$XDG_RUNTIME_DIR" /tmp/pulse
  pnpm install --frozen-lockfile --store-dir /pnpm-store --config.confirmModulesPurge=false

  # Firefox 沒有 sound server 時 AudioContext.resume() 不會完成；Chromium 接上 null sink 則時鐘會亂。
  # socket 不放在預設位置，Chromium 找不到；只有 Firefox 經 FIREFOX_PULSE_SERVER 連上（test/browser-launch.ts）。
  pulseaudio --daemonize=yes --exit-idle-time=-1 -n \
    --load="module-native-protocol-unix socket=/tmp/pulse/native auth-anonymous=1" \
    --load="module-null-sink sink_name=null"
  for _ in {1..50}; do
    [[ -S /tmp/pulse/native ]] && break
    sleep 0.1
  done
  [[ -S /tmp/pulse/native ]] || {
    echo 'PulseAudio 沒有啟動。' >&2
    exit 1
  }
  export FIREFOX_PULSE_SERVER=unix:/tmp/pulse/native

  exec "$@"
fi

# ---------------------------------------------------------------------------
# host：build image，以 container 重新執行本 script。
# ---------------------------------------------------------------------------
if [[ $# -eq 0 ]]; then
  echo "用法：$0 <指令…>" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/../.." && pwd)

# image 內的瀏覽器版本跟著 Playwright 走，兩者不同時 Playwright 找不到瀏覽器。
image_version=$(sed -n 's|^FROM mcr\.microsoft\.com/playwright:v\([0-9.]*\)-.*|\1|p' "$root/test/docker/Dockerfile")
package_version=$(sed -n 's|^ *"playwright": "\([^"]*\)".*|\1|p' "$root/package.json")
if [[ $image_version != "$package_version" ]]; then
  echo "test/docker/Dockerfile 的 Playwright image（$image_version）與 package.json 的 playwright（$package_version）不同。" >&2
  exit 1
fi
pnpm_version=$(sed -n 's|^pnpm = "\(.*\)"$|\1|p' "$root/mise.toml")

image=kikoeru-player-test
docker build --quiet --build-arg "PNPM_VERSION=$pnpm_version" -t "$image" "$root/test/docker" > /dev/null

store="${XDG_CACHE_HOME:-$HOME/.cache}/kikoeru-player/docker-pnpm-store"
mkdir -p "$store" "$root/.docker-cache/node_modules"
tty=()
[[ -t 0 && -t 1 ]] && tty=(-t)

# --ipc=host 與 --init 是 Playwright 文件建議的 Docker 設定。
exec docker run --rm --init --ipc=host ${tty[@]+"${tty[@]}"} \
  -u "$(id -u):$(id -g)" \
  -e KIKOERU_IN_CONTAINER=1 -e CI -e HOME=/tmp/home -e XDG_RUNTIME_DIR=/tmp/xdg \
  -v "$root:/work" -v "$root/.docker-cache/node_modules:/work/node_modules" -v "$store:/pnpm-store" \
  -w /work "$image" bash test/docker/run.sh "$@"
