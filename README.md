# kikoeru-player

kikoeru 前端使用的 headless 播放引擎（Engine）：在瀏覽器內以 HTTP Range 讀取媒體，在 Worker 內以 FFmpeg（wasm）demux 與解碼音訊、以 WebCodecs 解碼影片，經 AudioWorklet 輸出聲音，並把影片畫到 App 提供的 canvas。Engine 不含任何 UI，只提供 API 與事件。

## 使用

> 公開 API 尚未定型。以下為骨架，各節內容由實作 issue 補上；API 的行為以型別的 TSDoc 為準，本文件不逐一列出功能。

### 安裝

Engine 不發到 npm，以 GitHub Release 的 tarball 安裝：

```jsonc
// package.json
{
  "dependencies": {
    "kikoeru-player": "https://github.com/mocukie/kikoeru-player/releases/download/v<版本>/kikoeru-player-<版本>.tgz"
  }
}
```

### Vite 設定

Engine 以不 bundle 的 ESM 發布，Worker、AudioWorklet 與 wasm 資產由 App 的 Vite 處理。必須把 Engine 排除在 dependency pre-bundling 之外：

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ['kikoeru-player'] },
});
```

### 資產部署

- `.wasm` 與 glue 必須與頁面同源，`.wasm` 以 `Content-Type: application/wasm` 提供，才能 streaming compile。
- 頁面必須是 secure context（HTTPS 或 localhost），AudioWorklet 才能使用。
- Engine 不需要 COOP/COEP。
- 使用背景播放模組時，CSP 的 `media-src` 要允許 `blob:`。

### 最小範例

```ts
import { createEngine, isAbortError } from 'kikoeru-player';

// 整個 App 一個 Engine，換檔用 load()。
const engine = createEngine();

engine.addEventListener('statechange', (e) => console.log(e.state, e.paused));
engine.addEventListener('timeupdate', (e) => console.log(e.currentTime));

// resolve 時 state 為 'ready'，duration、tracks 已就緒。
await engine.load({ kind: 'http', url: '/media/track.flac' });

// 指令被較新的指令取代時以 AbortError reject，忽略即可。
const report = (error: unknown) => {
  if (!isAbortError(error)) console.error(error);
};
// play() 要在 user gesture 內呼叫，AudioContext 才能解鎖。
playButton.addEventListener('click', () => engine.play().catch(report));
pauseButton.addEventListener('click', () => engine.pause().catch(report));
```

### 背景播放模組

`kikoeru-player/background` 的 `attachBackgroundPlayback(engine, options?)` 讓 OS 把 App 當成正在播放的媒體播放器（鎖屏、背景、系統媒體控制）。Media Session 的 handler 仍由 App 負責。

```ts
import { createEngine } from 'kikoeru-player';
import { attachBackgroundPlayback } from 'kikoeru-player/background';

const engine = createEngine();
// 建立 Engine 之後、第一次 play() 之前 attach：設定 audioSession，並讓靜音 anchor 跟著 paused 播放與停止。
const background = attachBackgroundPlayback(engine, { log: (entry) => console.debug(entry) });

// Media Session 由 App 自己設定。
navigator.mediaSession.setActionHandler('play', () => void engine.play());
navigator.mediaSession.setActionHandler('pause', () => void engine.pause());

// 不再需要時（engine.destroy() 會自動 detach）。
background.detach();
```

### 支援的瀏覽器

近兩年的 Chromium、Firefox、Safari（含 iOS Safari）。音訊在所有支援的瀏覽器上都能播放；影片依瀏覽器的 WebCodecs 支援而定，不支援的影片軌只播音訊。

### 授權

- Engine 自己的程式碼採 MIT（`LICENSE`）。
- 內含的 FFmpeg（libav.js build）採 LGPL-2.1-or-later，聲明見 `NOTICE`，原始碼附在對應的 `ffmpeg-wasm-*` GitHub Release。App 可以用匯出的 `thirdPartyNotices` 在「關於」頁顯示聲明與原始碼連結。

## 開發

### 環境

- [mise](https://mise.jdx.dev/)：`mise install` 安裝 `mise.toml` 鎖定的 Node 與 pnpm，再 `pnpm install`。
- Docker：`pnpm wasm:build`、`pnpm media:gen` 與 `pnpm verify:docker` 需要；`pnpm media:gen` 另需 python3。
- 瀏覽器：`pnpm exec playwright install --with-deps chromium`（`pnpm verify` 用；`--with-deps` 以 sudo 安裝系統函式庫）。Firefox 用 `pnpm verify:docker` 在 container 內跑。
- 第一次開發前先執行 `pnpm wasm:fetch` 與 `pnpm media:gen`。

### 常用指令

| 指令 | 用途 |
|---|---|
| `pnpm dev` | 啟動 Demo 頁的 dev server（HTTPS 自簽，手機可用 LAN IP 連線） |
| `pnpm build` | tsc 輸出到 `dist/`、複製 wasm 資產、產生 notices；加 `--watch` 可與 App 同時開發 |
| `pnpm typecheck` | 型別檢查 |
| `pnpm lint` | ESLint 與 Prettier 的 check |
| `pnpm format` | Prettier 寫入 |
| `pnpm test` | Node 測試 |
| `pnpm test:browser` | Vitest browser mode，預設 Chromium 與 Firefox，可用 `--project` 指定 |
| `pnpm e2e` | Playwright E2E，同上 |
| `pnpm verify` | lint → typecheck → Node 測試 → browser mode 與 E2E（只跑 Chromium）；交付 PR 前必須通過 |
| `pnpm verify:docker` | 在 Playwright image 內跑 Chromium 與 Firefox 的完整組合，用來重現 CI |
| `pnpm wasm:fetch` | 下載與 `wasm/` tree hash 相符的 wasm Release 到 `wasm/dist/` |
| `pnpm wasm:build` | 修改 `wasm/` 後在 Docker 內 build wasm |
| `pnpm media:gen` | 產生 CI 組的測試媒體 |
| `pnpm media:gen:manual` | 產生手動組的長檔 |

`dev`、`build`、`test:browser`、`e2e` 開始前會檢查 wasm 與測試媒體，缺少時停下並提示要執行的指令。

App 與 Engine 同時開發時，在 App 端 `pnpm link ../kikoeru-player`（不 commit），Engine 端執行 `pnpm build --watch`。

### 文件索引

| 主題 | 權威文件 |
|---|---|
| 名詞 | [`GLOSSARY.md`](GLOSSARY.md) |
| 開發規則（commit、branch、PR、硬性約束） | [`AGENTS.md`](AGENTS.md) |
| 架構：執行緒分工、目錄與依賴規則、訊息協定、不變式 | [`docs/architecture.md`](docs/architecture.md) |
| 測試：分層、瀏覽器、測試媒體、每張實作 issue 的最低要求 | [`docs/testing.md`](docs/testing.md) |
| 實機清單 | [`docs/device-checklist.md`](docs/device-checklist.md) |
| 決定與理由 | [`docs/adr/`](docs/adr/) |
| 公開 API | 型別的 TSDoc（`src/index.ts` 匯出的型別） |
