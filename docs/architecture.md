# kikoeru-player 架構規則

本文件是實作時的規則手冊：套件形狀、執行緒分工、目錄與依賴規則、訊息協定與不變式。違反依賴規則的程式碼會被 ESLint 擋下。決定的理由見 [`docs/adr/`](adr/)，名詞見 [`CONTEXT.md`](../CONTEXT.md)，測試見 [`testing.md`](testing.md)。

## 技術選型

| 項目 | 選擇 | 備註 |
|---|---|---|
| 語言 | TypeScript `~6.0` | 對齊 kikoeru 前端 |
| 打包 | tsc 輸出不 bundle 的 ESM | 由 App 的 Vite 處理 Worker 與資產（[ADR-0005](adr/0005-wasm-release-and-engine-package.md)） |
| FFmpeg | libav.js 自訂 variant，Asyncify | [ADR-0001](adr/0001-libavjs-asyncify.md)、[ADR-0003](adr/0003-decode-paths.md) |
| Lint／format | ESLint 10（flat config）、`typescript-eslint`（type-checked）、`eslint-plugin-boundaries`、Prettier + `eslint-config-prettier` | |
| 測試 | Vitest 5（node 與 browser mode）、Playwright | 見 [`testing.md`](testing.md) |
| Demo 頁 | vanilla TS + Vite | 不引入 UI framework |
| 工具鏈 | mise 鎖 Node 24 與 pnpm | lockfile `pnpm-lock.yaml` 必須 commit |

## 套件形狀

- repo 根目錄就是唯一的套件 `kikoeru-player`，不使用 pnpm workspace。
- `package.json` 的 `exports` 只有兩個 entry：`.`（Engine）與 `./background`（[背景播放模組](adr/0006-background-playback-module.md)）。內部模組（例如 `createEngineWith`）不放進 `exports`。
- `files` 只有 `dist/`、`LICENSE`、`NOTICE`、`LICENSES/`。
- `test/fixture-app/` 有自己的 `package.json`，但**不加入 workspace**：它要以 `pnpm pack` 產生的 tgz 安裝，才能驗證真正發出去的套件。用 link 或 workspace 安裝會繞過打包。

## 執行緒分工

詳見 [ADR-0002](adr/0002-media-worker-per-load.md)。

| 執行環境 | 負責 |
|---|---|
| 主執行緒 | 公開 API、指令佇列、狀態鏡像、`AudioContext`、依音訊時鐘把 `VideoFrame` 畫到 App 的 canvas |
| media Worker（每次 load 一個） | Range I/O 與快取、預讀、demux、音訊解碼與 filter graph、`VideoDecoder`、內嵌字幕 cue |
| AudioWorklet | ring buffer、音訊時鐘、淡入淡出；由 media Worker 經 `MessageChannel` 直接供料 |

## 目錄結構

```
src/
  index.ts         公開 API 的匯出（套件的 "." entry）
  main/            主執行緒（lib: dom）
  worker/          media Worker（lib: webworker）
  worklet/         AudioWorklet，單一檔案（lib: audioworklet）
  protocol/        執行緒之間的訊息型別，只有 type
  background/      背景播放模組（套件的 "./background" entry，lib: dom）
demo/              Demo 頁（index.html、main.ts）
test/
  media/           測試媒體的產生 script；輸出到 gitignored 的 test/media/out/
  server/          Vite middleware：/media/* 的 Range 與故障注入
  fakes/           假 media Worker、假音訊輸出、記憶體 Source
  e2e/             Playwright 測試
  fixture-app/     Vite fixture App（不加入 workspace）
  lint/            ESLint 設定的 Node 測試；fixtures/ 模仿套件目錄，固定依賴規則與 Worker 寫法
scripts/           wasm 下載與 tree hash 檢查、notices 產生等 build 輔助 script
wasm/              Dockerfile、variant、patch、版本與 sha256 清單、build script；wasm/dist/ 不進 git
docs/
  adr/             決定紀錄
  device-checklist.md  實機清單
eslint.config.js   ESLint flat config，依賴規則在這裡
vite.config.ts     Demo 頁的 dev server（HTTPS 自簽，掛上 test/server）
vitest.config.ts   projects：node、browser（chromium、firefox）
playwright.config.ts
```

Node 測試（`*.test.ts`）與 browser mode 測試（`*.browser.test.ts`）都與原始碼放在一起，見 [`testing.md`](testing.md#測試分層)。

## 依賴規則

以 `eslint-plugin-boundaries` 強制：

| 從 | 可以 import |
|---|---|
| `src/index.ts` | `main/`、`protocol/` |
| `main/` | `main/`、`protocol/` |
| `worker/` | `worker/`、`protocol/`、libav.js 的 frontend |
| `worklet/` | 只能 `import type`（`protocol/`） |
| `protocol/` | 只能 `import type` |
| `background/` | 只能 import `src/index.ts`（公開 API） |
| `test/fakes/` | `protocol/`；只有測試檔可以 import 它 |
| `demo/` | `src/index.ts`、`src/background/` |

- `main/` 與 `worker/` 不互相 import。主執行緒只透過 `new Worker(new URL(...))` 啟動 Worker，雙方只以 `protocol/` 的型別溝通。
- `background/` 只用公開 API，證明 core 提供的 hook 足夠（[ADR-0006](adr/0006-background-playback-module.md)）。
- 同一個元素內的 import 不受依賴規則限制；但 `worklet/` 與 `protocol/` 的非測試檔一律只能 `import type`，`protocol/` 也不宣告任何 runtime 值。
- 測試檔（`*.test.ts`）可以 import 任何元素，也不受上一條的 `import type` 限制。
- `new Worker(...)` 只能用全域的 `Worker` 與下方「不變式」的字面寫法；`globalThis.Worker` 之類的屬性存取一律擋下。

## tsconfig

`dom`、`webworker`、`audioworklet` 三個 lib 的全域宣告會互相衝突，所以每個執行環境各有一份 tsconfig（根目錄的 `tsconfig.<名稱>.json`），由根目錄的 `tsconfig.json` 以 project references 串起來：

- `main`（含 `index.ts`、`background/`）：`lib: dom`。
- `worker`：`lib: webworker`。
- `worklet`：`audioworklet` 的全域型別。TypeScript 沒有內建這個 lib，改用 DOM lib generator 發布的 `@types/audioworklet`（`types: ["audioworklet"]`）。
- `protocol`：被以上三者引用，不使用任何環境的全域型別。
- 測試、Demo 頁、`scripts/` 各自另有 tsconfig，不輸出到 `dist/`。`scripts` 也涵蓋根目錄的 `*.config.{js,ts}`。

`pnpm build` 只 build `tsconfig.build.json` 引用的四個套件 project。`tsc -b` 不能搭配 `--noEmit` 使用 project references，所以 `pnpm typecheck` 也會輸出到 `dist/`；發布用的產物一律以 `pnpm build` 重新產生。

## 訊息協定

- 主執行緒、media Worker、AudioWorklet 之間的訊息型別全部定義在 `protocol/`，真實 Worker 與 `test/fakes/` 的假 Worker 共用同一份型別。
- 會改變輸出的指令遞增 **epoch**（seek、選軌、外掛音軌與 offset；改速度不遞增，見 [ADR-0004](adr/0004-audio-output.md)）。Worker 送出的 PCM、`VideoFrame`、cue 與狀態都帶著 epoch，收方丟棄過期的資料。
- 大型資料以 transfer 傳送：PCM 的 `ArrayBuffer`、`VideoFrame`、`MessagePort`。
- 不能用 libav.js 的回傳值判斷中止（被中止的 seek 仍回傳 0），一律以 epoch 判斷（[ADR-0002](adr/0002-media-worker-per-load.md)）。

## 不變式

`AGENTS.md` 的硬性約束在這裡展開。

### 平台與部署

- **不得要求 COOP/COEP**，不使用 `SharedArrayBuffer`；wasm 與 JS 的銜接只用 Asyncify（[ADR-0001](adr/0001-libavjs-asyncify.md)）。
- **Worker 的寫法**：只用字面寫法 `new Worker(new URL('./….js', import.meta.url), { type: 'module' })`，讓 App 的 Vite 能辨識並 bundle。路徑是 `./` 或 `../` 開頭、`.js` 結尾的字串字面值，例如主執行緒的 `'../worker/index.js'`。
- **AudioWorklet**：`addModule(new URL(…))` 只會原樣複製檔案，所以 worklet 是不 import 任何 runtime 程式碼的單一檔案。
- **wasm 資產**：glue 與 `.wasm` 是原封不動的資產，以 `new URL('./libav-….wasm.mjs', import.meta.url)` 參照，Worker 用 `import(/* @vite-ignore */ glueUrl)` 載入，license header 不經過 bundler（[ADR-0005](adr/0005-wasm-release-and-engine-package.md)）。
- **wasm 的修改**：只能改 `wasm/` 再重新 build；對 libav.js 的修改是 `wasm/` 內的 patch，不 fork。不得啟用 FFmpeg 的 GPL 元件。

### 資源

- **`VideoFrame`**：每張都要 `close()`，包括 epoch 過期而丟棄的、解碼錯誤路徑上的，以及 `destroy()` 時還在佇列中的。
- **讀取**：每個讀取都接受 `AbortSignal`；被取代的指令要中止它發出的讀取。
- **media Worker**：每次 `load()`、`reload()`、`unload()`、`destroy()` 都 terminate 舊的 Worker；wasm 記憶體只靠 terminate 回收（[ADR-0002](adr/0002-media-worker-per-load.md)）。
- **新增的資源**（Worker、libav instance、`VideoFrame` 等）都要計入 `getStats().resources`，讓 leak 測試看得到。

### 時間與音訊

- **對外的時間**一律在媒體時間軸上，單位是秒；容器的 pts、time_base、`start_time` 只在 Worker 內換算。
- **音訊時鐘**是唯一的時鐘，由 worklet 推進；影片與字幕都依它對齊，不使用 `performance.now()` 當播放時鐘（[ADR-0004](adr/0004-audio-output.md)）。
- **`AudioContext`**：整個 Engine 一個；`suspend()`、`resume()`、`close()` 一律經 Engine 自己的串行佇列，不依賴 `state` 判斷流程。
- **音訊解碼**只走 wasm，影片解碼只走 WebCodecs（[ADR-0003](adr/0003-decode-paths.md)）。

### 記憶體

- 快取、封包佇列、解碼佇列與 wasm 記憶體的上限見 [ADR-0007](adr/0007-readahead-in-byte-cache.md)。預讀只發生在 bytes 層的 Range 快取。

## Build 產物

- `pnpm build` 依各 tsconfig 以 tsc 輸出到 `dist/`，保留 `src/` 的目錄結構（`dist/index.js`、`dist/main/`、`dist/worker/`、`dist/worklet/`、`dist/background/`）。
- wasm、glue 與 libav.js frontend 從 `wasm/dist/` 複製到 `dist/wasm/`。
- `scripts/` 在 build 時產生 `wasm.json`（對應的 wasm Release tag 與 sha256）、`NOTICE`，以及寫入 wasm Release 原始碼 URL 的 `thirdPartyNotices`。
- `dev`、`build`、`test:browser`、`e2e` 開始前先檢查 `wasm/dist/` 是否符合 `wasm/` 的 tree hash，以及 CI 組的測試媒體是否存在；缺少時停下並提示 `pnpm wasm:fetch`、`pnpm media:gen`，不自動下載或產生。
- CI 與發版流程見 [ADR-0005](adr/0005-wasm-release-and-engine-package.md) 與 [`testing.md`](testing.md#本機與-ci)。
