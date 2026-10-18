# wasm 以 tree hash 定址的 Release 發布，Engine 以 Release tarball 發版

wasm 與 Engine 分成兩層產物：

- **wasm Release**：`wasm/` 目錄放 Dockerfile、variant、patch、版本與 sha256 清單、build script。Release tag 為 `ffmpeg-wasm-<libav.js 版本>-<wasm/ 的 git tree hash 前 8 碼>`（`git rev-parse HEAD:wasm`），內容是 dist 檔案（wasm、glue、frontend 與型別）、`sources.tar`（LGPL 的對應原始碼）、`NOTICE`、LGPL 全文與 `SHA256SUMS`，都是 Release 的平面檔案；`wasm/dist/` 是其中 `sources.tar` 以外的檔案。repo 不 commit 任何版本釘選，用哪一個 wasm 由 `wasm/` 的內容決定。
- **Engine 套件**：套件名稱 `kikoeru-player`，版本號為 SemVer（從 `0.1.0` 開始）。發版時 push `v*` tag，CI 確認 tag 與 `package.json` 的版本一致後 `pnpm pack`，把 tgz 附在 GitHub Release 上。套件內附 wasm、glue、frontend 的複本與 `wasm.json`（對應的 wasm Release tag 與 sha256），不含 `sources.tar`。kikoeru 的 `package.json` 寫 tarball URL，lockfile 記錄 integrity。

kikoeru-player 改為 public，Engine 自己的程式碼採 MIT，wasm 維持 LGPL-2.1-or-later；公開的 wasm Release 就是 LGPL §6 要求的原始碼提供處。

## Considered Options

- **維持 private repo**：從 private repo 的 Release 下載需要 token，kikoeru 的 `pnpm install` 與 Docker build 都要帶 token；原始碼也得另找公開的地方提供，兩邊要同步。
- **發到 npm public registry**：多一個帳號與發版 token，換來的 semver range 與 `pnpm update` 對唯一的使用者 kikoeru 沒有用處。GitHub Packages 的 npm registry 即使是 public package 也要認證才能安裝（ADR-0010 的理由）。
- **commit wasm 的版本釘選，或以自寫 script 計算輸入 hash**：釘選每次改 `wasm/**` 都要另外 bump；自寫 hash 要處理檔案順序與換行字元。git tree hash 本來就是 `wasm/` 內容的確定 hash，build 又是 bit-for-bit 可重現的，tag 已經足以識別一個 build。
- **另開 wasm workflow**：Engine 的 CI 要等另一個 workflow 發完 Release，兩者會競爭。改為同一個 `ci.yml` 的 job `ensure-wasm`，需要 wasm 的 job 都 `needs` 它。
- **glue 讓 App 的 bundler 打包**：要靠 bundler 保留 `/*! … */` 的 license header，Vite 或 Rolldown 每次改版都要重新確認。改為把 glue 與 `.wasm` 當成原封不動的資產，App 的 Vite 只複製並加上 hash。
- **Engine 自己先 bundle（Vite library mode、tsdown）**：Engine 多一套 bundler 設定，App 的 Vite 仍會再處理一次 `new Worker`。改為 tsc 輸出不 bundle 的 ESM，以 Vite fixture App 的驗收擋住出錯。

## Consequences

- push、PR 與 tag 的 CI 只有一個 `ci.yml`：`ensure-wasm`（tag 已存在就跳過，否則在 Docker 內 build、檢查 `config.h` 為 LGPL；發 Release 由接在後面的 `publish-wasm` 以 tag 跨 PR 互斥執行）→ `check`（lint、typecheck、Node 測試；型別取自 wasm Release 的 `libav.types.d.ts`）與 `browser`（Chromium 與 Firefox 的 Vitest browser mode 與 Playwright 跑 Demo 頁，加上 Vite fixture App 的驗收：license header 完整、`application/wasm`、streaming compile）→ `release`（只在 `v*` tag 時執行）。Safari 的排程 job 另外開，見[測試規範](../testing.md#本機與-ci)。cache 只用來加速：pnpm store、Playwright 的瀏覽器、上游 tarball、產生的測試媒體。
- `ensure-wasm` 在本 repo 每個 branch 的 push 都會執行，被放棄的 PR 會留下沒人用的 wasm Release。只要有 Engine 版本引用的 wasm Release 就永遠不刪，其他的可以手動清掉。
- 本機開發用 `pnpm wasm:fetch` 下載與 tree hash 相符的 Release，修改 `wasm/**` 時用 `pnpm wasm:build` 在 Docker 內 build。`dev`、`build`、`test:browser`、`e2e` 會先檢查 `wasm/dist/` 是否符合目前的 tree hash，不符合就停下並提示指令，不會自動下載。
- 打包規則：
  - Worker 一律寫成 `new Worker(new URL('./….js', import.meta.url), { type: 'module' })`，由 App 的 Vite bundle。
  - AudioWorklet 是不 import 任何東西的單一檔案，因為 `addModule(new URL(…))` 只會被原樣複製。
  - glue 以 `new URL('./libav-….wasm.mjs', import.meta.url)` 參照，Worker 用 `import(/* @vite-ignore */ glueUrl)` 載入；frontend 的 `.mjs`（0BSD）照常 bundle 進 Worker。
  - App 必須設定 `optimizeDeps.exclude: ['kikoeru-player']`，寫在 README。
- 公開 API 的變更：`EngineOptions.assets` 新增 `glueUrl`；新增匯出的 `thirdPartyNotices`，在 build 時寫入 wasm Release 的原始碼 URL，App 的「關於」頁直接使用。
- Engine 套件附 `LICENSE`（MIT）、`NOTICE`（FFmpeg 的 LGPL 聲明與 wasm Release 的連結）與 `LICENSES/LGPL-2.1.txt`。
- 改 Engine 要兩步：Engine 發版，kikoeru 再改 tarball URL。同時開發時，在 kikoeru 用 `pnpm link ../kikoeru-player`（不 commit），Engine 這邊執行 `pnpm build --watch`。
- kikoeru 端：授權條款不得禁止修改與逆向工程（LGPL §6），「關於」頁要有 FFmpeg 的聲明並連到 NOTICE 與原始碼。
