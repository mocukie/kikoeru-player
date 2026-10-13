#!/usr/bin/env bash
# 拋棄式 spike（#20）：報告用的整組量測。結果累加進 <res>/*.json。
# 用法：research/wasm-video-decode-spike/bench.sh <dist> <media> <res 目錄> [組別...]
#   組別：single flavors threads pipeline vfcost skip mix（預設全部）
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DIST=$1; MEDIA=$2; RES=$(mkdir -p "$3" && cd "$3" && pwd); shift 3
[ $# -gt 0 ] || set -- single flavors threads pipeline vfcost skip mix
B=chromium,webkit,firefox
R() { "$HERE/run-docker.sh" "$DIST" "$MEDIA" "$RES/$1.json" "$B" "$2"; }
MAIN="bbb-1080-8-2M bbb-1080-8-6M bbb-1080-10-2M bbb-1080-10-6M bbb-720-8-1M bbb-720-8-3M bbb-720-10-1M bbb-720-10-3M tos-800-8-3M tos-800-10-3M tos-534-8-1.5M bbb-1080-8-2M-tiles tos-800-8-3M-grain"
KEY="bbb-1080-8-2M bbb-1080-10-2M bbb-720-8-1M tos-800-8-3M"

for g in "$@"; do case $g in
  single) # 單執行緒、Engine 條件（Worker、Asyncify、libav.js 預設 -Oz）與最佳 flavor（-O3 -msimd128、不開 Asyncify）
    t=""; for f in $MAIN; do t+="decode:{\"file\":\"$f.mp4\"};decode:{\"file\":\"$f.mp4\",\"flavor\":\"o3s\",\"noasy\":true};"; done
    R single "$t" ;;
  flavors) # 編譯選項與 Asyncify 的影響
    t=""; for f in $KEY; do for fl in oz o3 o3s; do for na in false true; do t+="decode:{\"file\":\"$f.mp4\",\"flavor\":\"$fl\",\"noasy\":$na};"; done; done; done
    R flavors "$t" ;;
  threads) # wasm threads（需要 crossOriginIsolated）。pool = threads + 1 個 pthread Worker
    t=""; for f in bbb-1080-8-2M bbb-1080-10-6M bbb-1080-8-2M-tiles tos-800-8-3M; do for n in 1 2 3 4 6 8; do
      t+="decode:{\"file\":\"$f.mp4\",\"flavor\":\"o3s\",\"noasy\":true,\"target\":\"thr\",\"threads\":$n,\"pool\":$((n+1)),\"coi\":true};"; done; done
    R threads "$t" ;;
  pipeline) # 完整路徑：解碼 → I420（10-bit 轉 8-bit）→ VideoFrame → transfer → 主執行緒 drawImage
    t=""; for f in bbb-1080-8-2M bbb-1080-10-2M bbb-720-8-1M bbb-720-10-1M; do for fl in oz o3s; do
      na=$([ $fl = o3s ] && echo true || echo false); t+="m-pipeline:{\"file\":\"$f.mp4\",\"flavor\":\"$fl\",\"noasy\":$na};"; done; done
    R pipeline "$t" ;;
  vfcost) R vfcost 'vfcost:{"n":300}' ;;
  skip) # 掉格的手段：只解 reference frame（skip_frame=noref → DAV1D_DECODEFRAMETYPE_REFERENCE）、不套 film grain
    t=""; for f in bbb-1080-8-2M bbb-1080-10-6M tos-800-8-3M-grain; do
      t+="decode:{\"file\":\"$f.mp4\",\"flavor\":\"o3s\",\"noasy\":true,\"skip\":\"noref\"};"; done
    t+="decode:{\"file\":\"tos-800-8-3M-grain.mp4\",\"flavor\":\"o3s\",\"noasy\":true,\"grain\":false};"
    R skip "$t" ;;
  mix) # dav1d 放進主 variant（Asyncify、FFmpeg -Oz、只有 dav1d 用 -O3 -msimd128）與同設定的獨立 wasm
    t=""; for f in $KEY; do
      t+="decode:{\"file\":\"$f.mp4\",\"variant\":\"kikoeru-afv\",\"flavor\":\"oz\"};"
      t+="decode:{\"file\":\"$f.mp4\",\"variant\":\"kikoeru-afv\",\"flavor\":\"mix\"};"
      t+="decode:{\"file\":\"$f.mp4\",\"flavor\":\"mix\",\"noasy\":true};"; done
    R mix "$t" ;;
esac; done
