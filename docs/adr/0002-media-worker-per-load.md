# 執行緒分工與每次 load 一個 media Worker

Engine 分成三個執行環境：
- **主執行緒**：公開 API、指令佇列、狀態鏡像、`AudioContext`（必須在 user gesture 內同步解鎖），以及把 `VideoFrame` 依音訊時鐘畫到 App 的 canvas。
- **media Worker**：Range I/O 與快取、所有 demuxer、FFmpeg 音訊解碼與 filter graph（重採樣、downmix、轉 float planar、`atempo`）、`VideoDecoder`、內嵌字幕 cue 的抽取。
- **AudioWorklet**：由 media Worker 經 `MessageChannel` 直接供料，主執行緒不經手 PCM。

media Worker 屬於一次載入，不屬於整個 Engine：`load()`、`reload()`、`unload()`、`destroy()` 都會 terminate 舊的 Worker，需要時再建立新的。原因是 WebKit 不會及時回收放掉參照的 wasm instance（每個約 30–100 MiB），只有 `terminate()` 保證歸還；每次 load 重建 Worker 只多 35–40 ms。被取代的 load 也因此一次 terminate 就清乾淨，不必設計 open 或 probe 中止後的恢復路徑。

## Considered Options

- **每個 Engine 一個 Worker，load 時在 Worker 內換 instance**：在 WebKit 上，連續切換上百首時記憶體會一路累積。
- **外掛音軌另開 Worker**：實測 CPU 沒有差別，記憶體卻多 20–100 MiB。
- **demux 與 decode 拆到不同 Worker**：沒有 SharedArrayBuffer 時，每個封包都要多複製一次。
- **Worker 內以 OffscreenCanvas 繪製**：`transferControlToOffscreen()` 之後主執行緒不能再改 canvas 尺寸，所以 v1 一律在主執行緒繪製，OffscreenCanvas 留待之後當 App 選用的模式。

## Consequences

- 主執行緒在第一次 `load()` 或 `unlockAudio()` 時 `compileStreaming` 一次，持有 `WebAssembly.Module`，再 postMessage 給每個新的 Worker。
- AudioWorklet 沿用到 `destroy()`，每個新的 Worker 用新的 `MessageChannel` 接上它。
- 被取代的工作以 **epoch** 判斷：會改變輸出的指令會遞增 epoch，Worker 送出的 PCM、`VideoFrame`、cue 與狀態都帶著 epoch，收方丟棄舊的資料（`VideoFrame` 要 `close()`）。不能用 libav.js 的回傳值判斷中止：被中止的 seek 仍回傳 0。
- Worker 崩潰（wasm trap、OOM、`onerror`）時，state 進入 `error`，回報 `EngineError('INTERNAL', fatal: true)`，不自動 reload，由 App 決定要不要 `reload()`。
