#!/usr/bin/env bash
# 拋棄式 spike（#17）：在官方 Playwright image 內跑 run.mjs（Chromium、WebKit、Firefox 都已內建）。
# 用法：research/libavjs-runtime-spike/run-docker.sh <dist> <media> <out.json> <browsers> '<tests>'
# 先在本目錄 npm install（playwright 版本要跟 image 一致）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DIST=$(cd "$1" && pwd); MEDIA=$(cd "$2" && pwd); OUT=$(realpath "$3")
mkdir -p "$(dirname "$OUT")"
docker run --rm --ipc=host --init -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$HERE:$HERE" -v "$DIST:$DIST:ro" -v "$MEDIA:$MEDIA:ro" -v "$(dirname "$OUT"):$(dirname "$OUT")" -w "$HERE" \
  mcr.microsoft.com/playwright:v1.63.0-noble node run.mjs "$DIST" "$MEDIA" "$OUT" "$4" "$5"
