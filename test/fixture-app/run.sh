#!/usr/bin/env bash
# Vite fixture App 的驗收（docs/testing.md「本機與 CI」、ADR-0005）：pnpm fixture 與 CI 的 browser job 都經過這裡。
# 用法：test/fixture-app/run.sh [Playwright 的參數…]，例如 test/fixture-app/run.sh --project chromium
#
# 1. scripts/pack.ts：pnpm pack（prepack 會 pnpm build），並檢查套件的檔案清單。
# 2. 以 tgz 安裝到 test/fixture-app/（不加入 workspace，不用 link），以 App 的角度做型別檢查。
# 3. vite build，再以 vite preview 跑 acceptance.spec.ts。
# vite 與 Playwright 取自根目錄的 node_modules（Node 的解析會往上找），fixture 只安裝 kikoeru-player。
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
app="$root/test/fixture-app"
cd "$root"

node scripts/check-media.ts

rm -rf "$app/.pack" "$app/node_modules" "$app/dist"
tgz=$(node scripts/pack.ts "$app/.pack")
# 檔名帶版本；package.json 以固定的檔名參照。
mv "$tgz" "$app/.pack/kikoeru-player.tgz"

# 每次都重新解析 tgz（內容每次 build 都不同），不留 lockfile。
pnpm install --dir "$app" --ignore-workspace --config.lockfile=false \
  --config.confirmModulesPurge=false --reporter=append-only

pnpm exec tsc -p "$app/tsconfig.app.json"
pnpm exec vite build "$app" --logLevel warn
pnpm exec playwright test -c "$app/playwright.config.ts" "$@"
