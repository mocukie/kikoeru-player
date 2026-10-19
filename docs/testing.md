# kikoeru-player 測試規範

本文件規定測試的分層、瀏覽器、測試媒體、故障注入、實機清單與每張實作 issue 的最低要求。目錄位置見[架構規則「目錄結構」](architecture.md#目錄結構)，指令見 [README「常用指令」](../README.md#常用指令)。

## 測試分層

| 層 | 測什麼 | 位置與檔名 | 指令 |
|---|---|---|---|
| Node（Vitest node project） | 純邏輯：指令佇列、取代、epoch、time map、錯誤分類、重試、LRU、ring buffer 水位與 hysteresis | 與原始碼並列的 `*.test.ts` | `pnpm test` |
| browser mode（Vitest browser project） | libav.js 的 demux 與解碼、media Worker（含真實 Worker 對協定的行為）、filter graph（`atempo`、重採樣、downmix）、`VideoDecoder`、AudioWorklet | 與原始碼並列的 `*.browser.test.ts`；環境的 smoke test 在 `test/smoke/` | `pnpm test:browser` |
| E2E（Playwright） | 對 Demo 頁測整個播放流程、A/V 同步、leak | `test/e2e/` 的 `*.spec.ts` | `pnpm e2e` |

### Node 層

- 主執行緒與 Worker 之間的訊息協定是這一層的測試接縫：測試以內部的 `createEngineWith(deps)` 注入假 media Worker 與假音訊輸出來驅動 `Engine`。`createEngineWith` 不放進 package `exports`，公開的 `createEngine()` 只是帶真實 deps 呼叫它。
- 假 Worker 放在 `test/fakes/`，由測試腳本控制每個回覆的時機與內容，不重新實作 Worker 的行為；協定型別與真實 Worker 共用（`src/protocol/`）。
- seek／load 被取代、destroy 中途、Worker 崩潰成 `INTERNAL` 這些競態，都在這層以決定性的方式測。
- 快取與重試用 `test/fakes/` 的記憶體 `Source` 測。

### browser mode

- seek 的起點精準度在這層比對解碼後的 PCM（preroll 依 [ADR-0003](adr/0003-decode-paths.md)）：0 sample；經重採樣的路線 ≤ 1 sample。Matroska／WebM 的時間戳以 ms 為單位，容器本身就有 ±0.5 ms 的捨入，容許 1 ms。

### E2E

- 對 Demo 頁執行。Demo 頁沿用 spike 的事件 log，並提供公開 API 的操作。Demo 頁預設 attach 背景播放模組；只測 Engine 本身的 spec 以 `/demo/?background=0` 開啟。
- **自動同步斷言**：用 Playwright init script 包住 `AudioNode.prototype.connect`，在接到 `destination` 的地方旁接錄音 worklet 偵測 beep 起點，並讀 canvas pixel 偵測白框。錄音點在 `destination` 之前，比對時要扣掉 Engine 回報的輸出延遲。公開 API 不為此改變。

  | 斷言 | 容差 |
  |---|---|
  | beep 起點對 `currentTime` | ≤ 20 ms |
  | 白框對 beep | ≤ 1 個影片 frame + 1 個 rAF（30 fps 約 50 ms） |
  | 音軌 offset ±500 ms | 方向正確，誤差 ≤ 20 ms |
  | `atempo` 1.25x 的 beep 間隔 | 0.8 s ± 10 ms |
  | 變速（經過 `atempo`）時 beep 起點對 `currentTime` | ≤ 40 ms（見下方說明） |

  變速時的容差較寬：`atempo`（WSOLA）在完全靜音之後找不到波形對齊的依據，會把 beep 的音頭提早（實測 12–24 ms）。這是演算法的特性，不是時鐘誤差；time map 另以 beep 間隔驗證。40 ms 低於 ITU-R BT.1359 對聲音領先的可察覺門檻（約 45 ms）。

  容差寫成常數集中在 `test/e2e/` 的一個檔案，flaky 時只調那裡。
- **leak 測試**：連續 load 100 次，混入被取代的 load、播放中 destroy、外掛音軌，使用 CI 組的短檔。斷言：
  - 以 CDP 數 Worker target，並在 GC 後量 JS heap。
  - `getStats().resources = { workers, libavInstances, openVideoFrames }`：destroy 後全為 0；換檔後 `workers` 為 1、`libavInstances` 等於來源數。
  - destroy 後 `network.inflight` 為空；換檔後進行中的請求都屬於目前的媒體（預讀）。

## 瀏覽器

- **Chromium 與 Firefox**：在同一個 Linux 的 Playwright 官方 image 內跑 browser mode 與 E2E，兩者都是 PR 必須通過的檢查。
  - Playwright 套件與官方 image 統一為 `1.64.1`；`test/docker/Dockerfile` 的 `v1.64.1-noble` 同時釘選多架構 manifest index digest，`test/docker/run.sh` 保留套件與 image tag 的版本一致性檢查。
  - 只給 Firefox 起 PulseAudio null sink；Chromium 不接 PulseAudio，否則時鐘會亂。
  - Chromium 用 `--autoplay-policy=no-user-gesture-required`，Firefox 用 `media.autoplay.default=0`，或在出聲前 `userEvent.click()`。不依賴 Playwright `evaluate` 自帶的 gesture。
  - Firefox 的 H.264／AAC 需要系統的 libavcodec（官方 image 已有）；HEVC 在 Firefox 與 Chromium 都只測不支援路徑。
  - Firefox 解出的 `VideoFrame` 是 `BGRX`，Chromium 是 `I420`，繪製路徑兩種都要涵蓋。
  - Linux 的 Playwright WebKit 不跑：媒體走 GStreamer，行為不代表 Safari。
  - 啟動設定集中在 `test/browser-launch.ts`，Vitest 與 Playwright 共用；image 與 PulseAudio 的設定在 `test/docker/`。
- **Safari**：macOS runner 上的 job，headed、serial，只跑 browser mode 中和平台有關的一小組測試：AudioWorklet 能出聲、`interrupted` 與解鎖、worklet 收 transferred `MessagePort`、WebCodecs H.264／VP9，以及 AV1 回報 `'platform'` 的路徑。不跑 E2E。job 開始時以 `system_profiler SPAudioDataType` 檢查音訊裝置，沒有就直接失敗。觸發時機：每週排程、手動觸發與 push `v*` tag 發版前，不擋 PR。
- **iOS／Android**：只用實機，不用 Simulator，見下方「實機清單」。

實作細節（PulseAudio、autoplay、libavcodec、`webdriverio@9` 的坑、runner 的音訊裝置與 Safari 版本）見 [桌面 Firefox、Safari 的媒體測試自動化](https://github.com/mocukie/kikoeru-player/blob/research/browser-automation/docs/research/browser-automation.md)。

## 測試媒體

- 產生 script 在 `test/media/`（`gen-media.sh`、`gen-subs.py`），FFmpeg image 釘 digest，輸出放 gitignored 的 `test/media/out/`。
- **CI 組**（`pnpm media:gen`）：短檔（幾秒到 20 秒），涵蓋全部 codec、多軌、內嵌 SRT／ASS、外掛音軌，以及壞檔（截斷、壞封包、假副檔名）。
- **手動組**（`pnpm media:gen:manual`）：長檔（45 分鐘 MP3、660 MB WAV、1–2 GB MKV），只在實機或記憶體測試時產生。
- CI 依 script 內容的 hash 快取產物。
- 測試只依賴媒體內容的特徵（beep 位置、時長、軌道組成），不依賴 byte 一致。
- 原則上不 commit 二進位檔；script 做不出來而需要 commit 時，**先問過 user**。

## HTTP 來源與故障注入

`test/server/` 的 Vite middleware 供 browser mode 與 Demo 頁共用：

- `/media/*` 提供 `test/media/out/` 的檔案，支援 Range；`/media/index.json` 列出 CI 組媒體的路徑，Demo 頁以它列出可選的媒體。browser mode 的測試媒體也走 `/media/*`：Vitest 自己的靜態檔案不正確處理 Range。
- `/src/wasm/*` 原樣提供 `wasm/dist/` 的檔案，讓 Engine 預設的 wasm 與 glue 位置在 dev 與測試中也能用（見[架構規則「平台與部署」](architecture.md#平台與部署)）。
- `/media/*` 的故障由 query 參數控制（實作與完整說明在 `test/server/faults.ts`），Demo 頁可以選擇：

  | 參數 | 效果 |
  |---|---|
  | `fault=<status>@<n>` | 第 n 個請求回應 `<status>`，例如 `503@2`、`401@4`；`200` 表示忽略 Range、回應整個檔案 |
  | `fault=stall@<位置>` | 第一個涵蓋該檔案位置的回應送到那裡就停住，連線保持開著，例如 `stall@1MB` |
  | `fault=drop@<位置>` | 同上，但在那裡切斷連線，例如 `drop@500KB` |
  | `delay=<ms>` | 每個回應先等 `<ms>` 毫秒 |

  規則結尾加 `+`（URL 中寫成 `%2B`）表示持續發生，例如 `503@2+`；多個規則以逗號分隔。請求的計數以完整的 URL 區分，測試在 query 加上不重複的 `id` 就互不影響；同一個 URL 的 `reload()` 接著計數。

  預讀會在播放位置之前發出請求，「第 n 個請求」不一定在播放到那裡時才發生。要讓網路跟不上播放，Demo 頁的 query 可以縮短預讀（`/demo/?readahead=0.5`，另有 `cacheMiB`、`stallTimeout`、`stallAttempts`，見 `demo/main.ts`），再加上 `delay`。

不需要 kikoeru 後端。cookie、`.wasm` 的 Content-Type 與壓縮屬於 kikoeru 端的部署驗證。

## 實機清單

- [`device-checklist.md`](device-checklist.md)，桌面（Firefox、Safari）與手機（iOS Safari、Android Chrome）分開列。
- 桌面部分只留自動化涵蓋不到的項目（真實喇叭與藍牙切換、長時間播放）。
- Demo 頁的事件 log 有「複製」按鈕；dev server 開 HTTPS（自簽），讓手機以 LAN IP 連線（AudioWorklet 需要 secure context）。
- 執行時機：每次發 minor 版本前，以及改到 [ADR-0004](adr/0004-audio-output.md)（音訊輸出）或 [ADR-0006](adr/0006-background-playback-module.md)（背景播放模組）的範圍時。結果貼成 issue 留言。

## 本機與 CI

| 場合 | 指令或 job | 內容 |
|---|---|---|
| 本機（agent 必須通過） | `pnpm verify` | lint → typecheck → Node 測試 → browser mode（Chromium）→ E2E（Chromium）→ fixture App（Chromium） |
| 本機重現 CI | `pnpm verify:docker` | 在 Playwright 官方 image 內跑 Chromium 與 Firefox 的完整組合 |
| CI `ensure-wasm`、`publish-wasm` | | wasm Release 不存在時才 build；發布以 tag 跨 PR 互斥，取得互斥後重新檢查（[ADR-0005](adr/0005-wasm-release-and-engine-package.md)） |
| CI `check` | 依賴 `ensure-wasm`、`publish-wasm`（lint 與 typecheck 用 wasm Release 的 `libav.types.d.ts`） | lint、typecheck、Node 測試 |
| CI `browser` | 依賴 `ensure-wasm`、`publish-wasm` 與媒體快取 | Chromium 與 Firefox 的 browser mode 與 E2E（含 leak 測試），以及 Vite fixture App 的驗收（`pnpm fixture`） |
| CI `release` | 只在 `v*` tag 與 `workflow_dispatch`（演練）時，依賴 `check` 與 `browser` | tag 與 `package.json` 的版本一致、wasm Release 已發布，`pnpm pack` 後附在 GitHub Release；演練只上傳成 workflow artifact |
| CI Safari | macOS runner，排程 | 見上方「瀏覽器」 |

PR 必須 `check` 與 `browser` 都通過。

本機 E2E 的 dev server 預設在 port 5273，非 CI 時會沿用已在跑的 server。多個 worktree 同時跑 `pnpm verify` 時，以環境變數 `E2E_PORT` 給每個 worktree 不同的 port。fixture App 的 `vite preview` 在 `FIXTURE_PORT`，沒有設定時是 `E2E_PORT` 加 1000（預設 6273），不沿用已在跑的 server。

### fixture App 的驗收

`test/fixture-app/` 是以 `pnpm pack` 的 tgz 安裝 Engine 的 Vite App（不加入 workspace，vite 與 Playwright 取自根目錄）。`pnpm fixture`（`test/fixture-app/run.sh`）依序：檢查套件的檔案清單 → 安裝 tgz → 以 App 的角度型別檢查（`tsconfig.app.json`）→ `vite build` → `vite preview` 上跑 `acceptance.spec.ts`：

- 套件內附的 wasm 對應 `wasm/dist/` 的 wasm Release，`thirdPartyNotices` 的原始碼 URL 指向它。
- build 輸出中 glue 與 `.wasm` 與套件內的複本 bytes 相同，glue 的 license header 完整。
- `.wasm` 以 `application/wasm` 提供、`compileStreaming` 成功，Worker 與 worklet 載入後能播放 CI 組的檔案。

## 每張實作 issue 的最低要求

1. 新增或修改的純邏輯：Node 測試涵蓋 issue 中列出的邊界情況。新增的指令要有競態測試：被取代、執行中 destroy、Worker 崩潰。
2. 改到 media Worker、wasm、WebCodecs 或 AudioWorklet：browser mode 測試。
3. App 看得到的播放行為：Demo 頁加上對應的操作與事件 log，並有 E2E 測試；可以量化同步的地方使用集中管理的容差常數。
4. 改到 [ADR-0004](adr/0004-audio-output.md) 或 [ADR-0006](adr/0006-background-playback-module.md) 的範圍，或新增平台相關的行為：更新 [`device-checklist.md`](device-checklist.md) 的項目（不必每張 issue 都實際跑一次）。
5. leak 測試保持通過；新增的資源計入 `getStats().resources`。
6. 本機 `pnpm verify` 通過，CI 的 `check` 與 `browser` 都通過。
