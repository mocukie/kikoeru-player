# browser-automation-spike

[測試策略](https://github.com/mocukie/kikoeru-player/issues/22) 的探測程式；報告在 `docs/research/browser-automation.md`。

- `gen-clips.sh`：在 Docker 內產生 H.264（Annex B）、VP9、AV1 的 30 frame 小檔到 `site/`。
- `site/`：探測頁（`lib.js`／`probe.js`）：AudioContext 加 AudioWorklet、OfflineAudioContext、WebCodecs 的 `isConfigSupported` 與實際解碼、Worker 內的 wasm。`server.mjs` 送 COOP/COEP 提供頁面。
- `run-pw.mjs`、`run-audio*.mjs`：在 `mcr.microsoft.com/playwright:v1.64.1-noble` 內用 Playwright 跑 Chromium、Firefox、WebKit；`pw-results.txt` 是結果。
- `vt/`：Vitest 5 browser mode 的同一組探測（Playwright provider 與 webdriverio provider）。
- `img-pulse/`：Playwright image 加 PulseAudio；`img-fx/`：`node:24` 加正式版 Firefox 158 與 geckodriver（tarball 需自行下載到該目錄）。
