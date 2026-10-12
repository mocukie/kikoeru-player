# Research：Worker 多執行緒架構的先例

- Ticket：[#8](https://github.com/mocukie/kikoeru-player/issues/8)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)）
- 下游決策：[#11 執行緒分工與 wasm 銜接方式](https://github.com/mocukie/kikoeru-player/issues/11)
- 相關 research：[#4 wasm 同步讀與非同步 fetch 的銜接](https://github.com/mocukie/kikoeru-player/issues/4)、[#6 音訊輸出的排程方式](https://github.com/mocukie/kikoeru-player/issues/6)、[#7 不變調變速](https://github.com/mocukie/kikoeru-player/issues/7)（結論：`atempo` 放在 Worker 內）
- 調查日期：2026-10-12
- 標記：**[已查證]** 有附一手來源（原始碼、規格、MDN browser-compat-data）；**[推論]** 由原始碼或規格推得、尚未實測；**[未查證]** 沒有找到一手來源，或需要實機才能回答。
- 調查方法：shallow clone 各專案的預設分支，閱讀原始碼；平台支援度查 `@mdn/browser-compat-data` 8.1.5（2026-10-08）的 `data.json`。**沒有**在瀏覽器實際執行。

| 對象 | 版本 / commit |
|---|---|
| movi-player | `0.4.1`，[`8bd0b50d7c`](https://github.com/MrUjjwalG/movi-player/tree/8bd0b50d7cdfcef635e015ea93e365876088969d)（與 kikoeru 的 movi-player research 同一版） |
| libmedia | `@libmedia/avplayer` 1.3.1，[`152f629d30`](https://github.com/zhaohappy/libmedia/tree/152f629d3021fd8013efa464fcb7b55f9fbe7753)；submodule [cheap `85cc79e032`](https://github.com/zhaohappy/cheap/tree/85cc79e032cbd417e3bb4a218bdf26da537b970b)、[common `00c9c3c481`](https://github.com/zhaohappy/common/tree/00c9c3c481cf7c53ed252cec6ca2dc6e9732ea28) |
| libav.js | `6.10.9`，[`c05a676d16`](https://github.com/Yahweasel/libav.js/tree/c05a676d16c1068cce6115594858c50a7ecad4b8) |
| W3C WebCodecs（規格與官方 samples） | [`7be369921f`](https://github.com/w3c/webcodecs/tree/7be369921f9e1a9ad3e12e8f8d4080cf98d8bf92) |
| web-demuxer（bilibili） | `4.0.0`，[`91721712b0`](https://github.com/bilibili/web-demuxer/tree/91721712b063bd65ac5963aa4e03e7eda4b17eff) |
| Mediabunny（media-player 範例） | `1.61.3`，[`cc108b3b49`](https://github.com/Vanilagy/mediabunny/tree/cc108b3b492d1e00aa976586b6d3f344a0bd178d) |
| Emscripten（Asyncify runtime） | [`ac0c9059fb`](https://github.com/emscripten-core/emscripten/tree/ac0c9059fb1d62af2be2ab75388d08cf5e91a883) |

## 結論摘要

1. **沒有 `SharedArrayBuffer` 的先例，共同做法是「Worker 綁一組 pipeline，跨執行緒只傳 transferable」。**
   - libmedia 在沒有 SAB 時用 worker proxy 模式：IO+demux 一個 Worker、音訊 decode+render 一個 Worker、影片 decode+render 一個 Worker（需要 OffscreenCanvas）。packet 以 serialize 加 transfer `ArrayBuffer` 在 Worker 之間傳。
   - libav.js 每個 instance 一個 Worker，所有 API 都是帶 id 的非同步 RPC。
   - W3C 官方 sample 把 demux、decode、繪製都放在同一個 media Worker，主執行緒只留 `AudioContext`。
   - 有 SAB 時 libmedia 改成每條 pipeline 各自一條 thread，共用 wasm memory。這條路需要 COOP/COEP，對本專案只能當可選的加速路徑。
2. **主執行緒一定要留下 `AudioContext`**：Web Audio 不暴露在 Worker 上。每個先例都在主執行緒建立 `AudioContext`。PCM 送到輸出端有三種做法：Worker 經 MessagePort 直接餵 AudioWorklet（libmedia）、SAB ring buffer（W3C sample，需要 COOP/COEP）、主執行緒排程 `AudioBufferSourceNode`（movi-player、Mediabunny）。選哪一種交給 #6。
3. **一個 Worker 還是多個？**
   - 先例都沒有把 demux 與「純 WebCodecs 的影片解碼」拆成兩個 Worker 的必要：libmedia 有 SAB 時才拆；沒有 SAB 時 decode 跟 render 綁在一起，demux 自己一個 Worker。
   - 一個 Worker 內可以有多個 demuxer：libmedia 的 demux Worker 用 taskId 同時服務主檔、DASH 的音訊、字幕與外掛字幕；W3C sample 在同一個 Worker 開兩個 demuxer。
   - **本專案的限制**：Emscripten Asyncify 在同一個 wasm instance 只允許一個 async 操作在進行中。共用一個 FFmpeg instance 的多個 demuxer，任何一個在等網路，其他 wasm 呼叫都得等。這是決定「每個 demuxer 一個 instance／Worker」的關鍵因素（詳見 §3.3）。
4. **VideoFrame 的歸屬**：
   - 規格上 `VideoFrame` 是 `Serializable` 也是 `Transferable`。transfer 會自動 close 來源端；沒放進 transfer list 的 `postMessage` 會產生第二個 reference，兩邊都要 close。
   - 先例的規則都是「最後持有的一方 close」：libmedia 的 render 從 decoder pull frame，swap 時 close 舊的那張；W3C sample 在下一張 frame 蓋過 pending frame 時 close 舊的。
   - 主執行緒畫或 Worker 用 OffscreenCanvas 畫都有先例。`transferControlToOffscreen()` 之後主執行緒不能再改 canvas 的 `width`／`height`（會拋 `InvalidStateError`），所以「畫到 app 給的 canvas」與「Worker 內 OffscreenCanvas」對 App 是不同的契約。
5. **指令與取消**：
   - 先例沒有一個完整做到 map 要求的「最後一個 seek 勝出、被取代的以 AbortError 結束」。libmedia 在 seeking 時直接忽略新的 seek；libav.js 的 RPC 沒有取消，只能 `terminate()`；web-demuxer 的同步 XHR 只有 terminate 能停。
   - 可借用的模式：generation 或 epoch 計數器丟掉過期結果（Mediabunny、movi-player #28 提案），demux 端設 abort flag 並中止 IO（libmedia 的 `IOFlags.ABORT`）。
6. **destroy 與記憶體**：wasm `Memory` 只能 grow，不能縮。要保證歸還 wasm heap，唯一可靠的方法是 `worker.terminate()`。libav.js、web-demuxer 的 destroy 都是 terminate；libmedia 則讓 Worker 跨 player 共用，destroy 只 unregister task，要呼叫 static `stopPipelines()` 才會 terminate。
7. **iOS Safari 的已知問題**（詳見 §6）：
   - `AudioContext` 的建立與 resume 必須在 user gesture 內同步完成，不能先等 Worker 的回覆（libmedia #14）。
   - 避免 `blob:` URL 的 Worker 與 nested Worker（movi-player 原始碼註解、web-demuxer #8）。
   - OffscreenCanvas 的 WebGL 要 Safari 17。
   - 頁面隱藏時 rAF 停止，背景的 `VideoDecoder` 可能被回收。
   - 手機上 AudioWorklet 與其他執行緒通訊延遲較大，libmedia 在手機上把 buffer 加倍。
8. **建議交給 #11 的候選**（詳見 §7）：**候選 A「每個 Engine 一個 media Worker」為首選**。I/O、所有 demuxer、FFmpeg 音訊解碼加 `atempo`、`VideoDecoder` 都在這個 Worker；`VideoFrame` transfer 到主執行緒，畫在 App 的 canvas。外掛音軌是否要第二個 wasm instance，取決於 #4 選定的銜接方式。

## 1. 各先例的執行緒分工

| 先例 | 主執行緒 | Worker | AudioWorklet | 需要 SAB／COOP/COEP | VideoFrame | destroy |
|---|---|---|---|---|---|---|
| movi-player 0.4.1 | 全部：I/O、FFmpeg wasm demux 與音訊解碼、WebCodecs、繪製、`AudioBufferSourceNode` 排程 | 只有一個 inline 的 timer Worker，給背景分頁發 tick | 無 | 不需要；`crossOriginIsolated` 時 `HttpSource` 才用 SAB | 同一執行緒，不跨執行緒 | 不涉及 Worker |
| libmedia（SAB） | `AVPlayer` facade、`AudioContext` | IO、Demux、AudioDecode、AudioRender、VideoDecode、VideoRender、MSE 各一條 thread，共用 wasm memory | `AudioSourceWorkletProcessor2`（SAB 版） | **需要** | 透過共享記憶體中的 frame list | `unregisterTask`；Worker 由 `stopPipelines()` 收掉 |
| libmedia（無 SAB，worker proxy） | 同上；沒有 OffscreenCanvas 時 VideoDecode+Render 也在主執行緒 | `IODemuxPipeline`、`AudioPipeline`（decode+render）、`VideoPipeline`（decode+render，用 OffscreenCanvas）；IO/Demux 與 Audio 的 Worker 是 static，所有 player 共用 | `AudioSourceWorkletProcessor`，經 MessagePort 直接向 audio Worker pull | 不需要 | decode 與 render 在同一個 Worker，render pull 後由 render close | 同上 |
| libav.js（worker 模式） | 呼叫端；`onread`／`onblockread` callback 在 host（呼叫 libav.js 的執行緒）執行 | 每個 `LibAV.LibAV()` instance 一個 Worker | 無（libav.js 不管輸出） | 不需要；`yesthreads` 才需要 | 不涉及（libav.js 輸出 `Frame` 物件，`libavjsTransfer` 決定 transfer 哪些 buffer） | `terminate()` = `worker.terminate()` |
| W3C WebCodecs sample（audio-video-player） | `AudioContext`、AudioWorklet、UI，每秒把 media time 推給 Worker | 一個 media Worker：兩個 mp4box demuxer、`AudioDecoder`、`VideoDecoder`、OffscreenCanvas 繪製（Worker 內的 rAF） | 讀 SAB ring buffer | **需要**（`_headers` 送 COOP/COEP） | Worker 內畫完就 close | 無 |
| web-demuxer | 呼叫端，以 `ReadableStream` 取 packet | 每個 `WebDemuxer` 一個 Worker，FFmpeg wasm 只做 demux | 無 | 不需要；用 Worker 內的同步 XHR 讀 Range | 不涉及（只輸出 packet） | `destroy()` = `terminate()` |
| Mediabunny media-player 範例 | 全部（TS demuxer、WebCodecs、`AudioBufferSourceNode` 排程、2D canvas） | 無 | 無 | 不需要 | 同一執行緒 | iterator `return()` |

### 1.1 movi-player（對照組：全部在主執行緒）

- 所有 demux、音訊解碼、render 都在主執行緒 [已查證]。主迴圈用 `MessageChannel` 讓出執行緒，避免長時間阻塞（[`MoviPlayer.ts` L10000–L10004](https://github.com/MrUjjwalG/movi-player/blob/8bd0b50d7cdfcef635e015ea93e365876088969d/src/core/MoviPlayer.ts#L10000-L10004)）。
- 唯一的 Worker 是背景播放用的 inline timer：用 `Blob` 建立 Worker，每 16 ms `postMessage('tick')`，因為背景分頁的主執行緒 timer 會被節流（[`MoviPlayer.ts` L17132–L17175](https://github.com/MrUjjwalG/movi-player/blob/8bd0b50d7cdfcef635e015ea93e365876088969d/src/core/MoviPlayer.ts#L17132-L17175)）。
- wasm 是單執行緒加 Asyncify，COOP/COEP 是可選的（[`troubleshooting.md` L49](https://github.com/MrUjjwalG/movi-player/blob/8bd0b50d7cdfcef635e015ea93e365876088969d/docs/guide/troubleshooting.md)）[已查證]。
- 多執行緒化在 [issue #28](https://github.com/MrUjjwalG/movi-player/issues/28)，仍是 open 的 feature request。提案內容 [已查證，但只是提案，沒有實作]：
  - 一個 demux Worker 負責 HTTP Range I/O、容器解析與讀取位置，提供 `open／read／seek／close` RPC，回傳 transferable 的 packet 批次。
  - 一個 decode Worker 擁有 `VideoDecoder`／`AudioDecoder` 與 wasm fallback。
  - 主執行緒只留時鐘、A/V 同步、render 與 UI。
  - seek 在 demux 端用 promise-chain mutex 序列化，再用 generation counter 丟掉過期的 fetch。
  - 建議的順序：demux Worker 先做，decode Worker 第二，OffscreenCanvas 最後。
  - 提案寫「OffscreenCanvas 目前只有 Chromium」，這已經過時：MDN BCD 記載 Firefox 105、Safari 16.4 都支援（§5.2）。

### 1.2 libmedia（有 SAB 與沒有 SAB 兩種模式）

- **模式判斷** [已查證]：
  - `cheap` 的 `USE_THREADS` = build 有開 `ENABLE_THREADS`，而且 `support.thread` 為真（[`config.ts` L13](https://github.com/zhaohappy/cheap/blob/85cc79e032cbd417e3bb4a218bdf26da537b970b/src/config.ts#L13)）。
  - `support.thread` 要求 Worker、`SharedArrayBuffer`、`Atomics`、`Proxy` 都存在（[`support.ts` L38](https://github.com/zhaohappy/common/blob/00c9c3c481cf7c53ed252cec6ca2dc6e9732ea28/src/util/support.ts#L38)）。
  - `createThreadFromClass` 只有在 `USE_THREADS` 或 `dispatchToWorker` 時才真的開 Worker，否則在主執行緒執行（[`thread.ts` L352–L357](https://github.com/zhaohappy/cheap/blob/85cc79e032cbd417e3bb4a218bdf26da537b970b/src/thread/thread.ts#L352-L357)）。
  - README 寫「不支援多執行緒會退回主執行緒」（[README L33–L40](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/README.md)），但 1.3.1 的程式碼另有 worker proxy 模式（`ENABLE_WORKER_PROXY` 預設為 `true`，[`tsconfig.json` L205](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/tsconfig.json#L205)），Changelog 稱為「非多線程 worker 模式」。**README 落後於程式碼。**
- **有 SAB**：IO、Demuxer、AudioDecoder、AudioRender、VideoDecoder、VideoRender、MSE 各是一條 thread（[`AVPlayer.ts` L4445–L4558](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/AVPlayer.ts#L4445-L4558)），packet 與 frame 以 pointer 在共享記憶體中傳遞。
- **沒有 SAB（worker proxy）** [已查證]：
  - `IODemuxPipelineProxy` 把 IO 與 Demux 放進同一個 Worker（[`IODemuxPipelineProxy.ts` L72–L76](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/worker/IODemuxPipelineProxy.ts#L72-L76)，`dispatchToWorker: true`）。
  - `AudioPipelineProxy` 是 decode 加 render 一個 Worker；`VideoPipelineProxy` 也是 decode 加 render 一個 Worker。
  - 影片 Worker 只有在 `supportOffscreenCanvas()` 成立時才使用；否則 VideoDecode 與 VideoRender 在主執行緒（[`AVPlayer.ts` L4415–L4440](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/AVPlayer.ts#L4415-L4440)）。
  - `supportOffscreenCanvas()` 對 Safari／iOS 17 以下回傳 false，理由是「WebGL 加 OffscreenCanvas 要 Safari 17+」（[`supportOffscreenCanvas.ts`](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/function/supportOffscreenCanvas.ts)）。
  - IO/Demux Worker 與 Audio Worker 是 `AVPlayer` 的 **static** 成員，所有 player instance 共用，以 `taskId` 區分；只有影片的 decoder thread 是每個 player 一個（[`AVPlayer.ts` L582–L614](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/AVPlayer.ts#L582-L614)，註解寫著「若需要同時播放大量影片，可以考慮做 VideoDecoderThreadPool」）。
- **資料流是 pull 式** [已查證]：
  - decoder 以 RPC `pull` 向 demuxer 要 packet（[`VideoDecodePipeline.ts` L240–L250](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avpipeline/src/VideoDecodePipeline.ts#L240-L250)）。
  - 沒有 SAB 時，demuxer 把 `AVPacket` serialize，並 transfer 其 `data.buffer` 與 side data（[`DemuxPipeline.ts` L634–L642](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avpipeline/src/DemuxPipeline.ts#L634-L642)）。
  - render 以 `pull` 向 decoder 要 frame（[`VideoRenderPipeline.ts` L274](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avpipeline/src/VideoRenderPipeline.ts#L274)）。
  - AudioWorklet 以 `pullBuffer` 向 audio render 要 PCM，採雙 buffer（[`AudioSourceWorkletProcessor.ts` L192–L250](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avrender/src/pcm/AudioSourceWorkletProcessor.ts#L192-L250)）。
  - 這條 MessagePort 由主執行緒建立 `MessageChannel`，一端交給 AudioWorklet，另一端 transfer 給 audio Worker，所以 PCM 不經主執行緒（[`AVPlayer.ts` L2478–L2511](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/AVPlayer.ts#L2478-L2511)）。
- **demux 是 TypeScript 寫的**，不是 FFmpeg libavformat，所以 libmedia 不需要處理 wasm 同步讀取接非同步 fetch 的問題。只有 codec 是獨立的 wasm 模組。這是它與本專案最大的結構差異。

### 1.3 libav.js（worker 模式）

- 三種模式：`direct`（同步、在呼叫端執行緒）、`worker`（預設）、`threads`（`yesthreads`，需要 SAB）（[`docs/API.md` L1–L70](https://github.com/Yahweasel/libav.js/blob/c05a676d16c1068cce6115594858c50a7ecad4b8/docs/API.md)）[已查證]。
- 「不同的 `LibAV.LibAV()` instance 在 Worker 模式下就是不同的執行緒」，所以 `yesthreads` 只用於單一 instance 內需要並行的情況。文件也提醒「有些瀏覽器對整頁可開的 Worker 數量限制相當低」（沒有指名是哪些瀏覽器）[已查證]。
- 文件明確建議：**如果 libav.js 本身就在你的 Worker 裡執行，可以設 `noworker`，讓它與你的 Worker 同步執行**。這可以避免 nested Worker [已查證]。
- RPC：每次呼叫遞增 id，`postMessage(msg, transfer)`，回應以 id 對應 promise（[`frontend.in.js` L404–L431](https://github.com/Yahweasel/libav.js/blob/c05a676d16c1068cce6115594858c50a7ecad4b8/src/frontend.in.js#L404-L431)）。沒有取消機制，`terminate()` 直接 `worker.terminate()`（L433–L435）；`direct` 模式的 `terminate()` 是 no-op（L554）[已查證]。
- I/O：`onread`／`onblockread` callback 由 Worker 轉回 host 執行緒呼叫（[`frontend.in.js` L366–L395](https://github.com/Yahweasel/libav.js/blob/c05a676d16c1068cce6115594858c50a7ecad4b8/src/frontend.in.js#L366-L395)）。wasm 端用 Asyncify 等待資料（`ASYNCIFY_IMPORTS` 含 `libavjs_wait_reader`，[`Makefile.m4` L33–L34](https://github.com/Yahweasel/libav.js/blob/c05a676d16c1068cce6115594858c50a7ecad4b8/Makefile.m4#L33-L34)）[已查證]。
  - 推論：在 libav.js 的 worker 模式下，fetch 會留在主執行緒，每次讀取都要多一趟跨執行緒。若 Engine 自己的 Worker 以 `noworker` 載入 libav.js，fetch 就和 demux 在同一個 Worker [推論]。
- `Frame`／`Packet` 物件的 `libavjsTransfer` 決定哪些 `ArrayBuffer` 會被 transfer，預設全部 transfer（[`docs/API.md` L108–L118](https://github.com/Yahweasel/libav.js/blob/c05a676d16c1068cce6115594858c50a7ecad4b8/docs/API.md)）[已查證]。

### 1.4 W3C WebCodecs 官方 sample

- `audio-video-player` [已查證]：
  - 主執行緒先 `canvas.transferControlToOffscreen()`，再把 OffscreenCanvas transfer 給 media Worker（[`audio_video_player.html` L75–L110](https://github.com/w3c/webcodecs/blob/7be369921f9e1a9ad3e12e8f8d4080cf98d8bf92/samples/audio-video-player/audio_video_player.html#L75-L110)）。
  - Worker 內有音訊、影片兩個 `MP4PullDemuxer` 與 decoder，用 Worker 內的 `requestAnimationFrame` 繪製（[`media_worker.js`](https://github.com/w3c/webcodecs/blob/7be369921f9e1a9ad3e12e8f8d4080cf98d8bf92/samples/audio-video-player/media_worker.js)）。
  - PCM 寫進 SAB ring buffer，交給主執行緒的 AudioWorklet 讀取（[`audio_renderer.js` L43–L47](https://github.com/w3c/webcodecs/blob/7be369921f9e1a9ad3e12e8f8d4080cf98d8bf92/samples/lib/audio_renderer.js#L43-L47)）。sample 的 `_headers` 送 COOP/COEP（[`samples/_headers`](https://github.com/w3c/webcodecs/blob/7be369921f9e1a9ad3e12e8f8d4080cf98d8bf92/samples/_headers)）。
  - **時鐘**：主執行緒每 1 秒把 `AudioContext` 算出的 media time 加上 `performance.now() + timeOrigin` 推給 Worker，Worker 再以 `performance.now()` 外插。註解說明理由是「Web Audio 介面沒有暴露在 WorkerGlobalScope」（[WebAudio/web-audio-api#2423](https://github.com/WebAudio/web-audio-api/issues/2423)），1 秒的間隔在本地測試下漂移小於 20 ms（[`audio_video_player.html` L155–L180](https://github.com/w3c/webcodecs/blob/7be369921f9e1a9ad3e12e8f8d4080cf98d8bf92/samples/audio-video-player/audio_video_player.html#L155-L180)）。
  - 暫停時先等 `AudioContext` 停住才通知 Worker 暫停，讓 ring buffer 在聲音停止前持續被填滿。
- `video-decode-display` [已查證]：`VideoDecoder` 在 Worker；每個 rAF 最多畫一張，新 frame 到達而 pending frame 還沒畫時，**先 close 舊的再換上新的**（[`worker.js` L22–L37](https://github.com/w3c/webcodecs/blob/7be369921f9e1a9ad3e12e8f8d4080cf98d8bf92/samples/video-decode-display/worker.js#L22-L37)）。

### 1.5 web-demuxer（bilibili）

- 每個 `WebDemuxer` 開一個 Worker 執行 FFmpeg wasm，只做 demux，packet 的 `data.buffer` 以 transfer 回傳（[`src/wasm.worker.ts`](https://github.com/bilibili/web-demuxer/blob/91721712b063bd65ac5963aa4e03e7eda4b17eff/src/wasm.worker.ts)）[已查證]。
- **I/O 不用 Asyncify 也不用 SAB**：改寫 Emscripten `WORKERFS` 的 `read`，在 Worker 內用**同步 XHR** 發 `HEAD` 與 `Range` GET；失敗時以 busy-wait 的 `sleep` 重試（[`post.js` L1–L90](https://github.com/bilibili/web-demuxer/blob/91721712b063bd65ac5963aa4e03e7eda4b17eff/lib/web-demuxer/post.js#L1-L90)）。build 參數是 `-lworkerfs.js`、`ENVIRONMENT=worker`、`ALLOW_MEMORY_GROWTH=1`，沒有 Asyncify（[`Makefile` L23–L36](https://github.com/bilibili/web-demuxer/blob/91721712b063bd65ac5963aa4e03e7eda4b17eff/Makefile#L23-L36)）[已查證]。
  - 代價 [推論]：
    - 同步 XHR 執行期間 Worker 完全阻塞，無法回應任何訊息，取消只能靠 `terminate()`。
    - XHR 沒有 `AbortSignal`；失敗時只有 status，錯誤分類要自己做。
    - 每次 read 一個 request，沒有預讀。
- 取消：`readAVPacket()` 回傳 `ReadableStream`，`cancel()` 送 `StopReadAVPacket`，等 Worker 回覆後才 resolve（[`web-demuxer.ts` L225–L300](https://github.com/bilibili/web-demuxer/blob/91721712b063bd65ac5963aa4e03e7eda4b17eff/src/web-demuxer.ts#L225-L300)）。`destroy()` 直接 `terminate()`（L120–L128）[已查證]。

### 1.6 Mediabunny media-player 範例（主執行緒的 WebCodecs 播放器）

- 範例全部在主執行緒：TS demuxer、WebCodecs、2D canvas、`AudioBufferSourceNode` 排程（[`media-player.ts` L384](https://github.com/Vanilagy/mediabunny/blob/cc108b3b492d1e00aa976586b6d3f344a0bd178d/examples/media-player/media-player.ts#L384)）[已查證]。
- 取消模式可以參考：全域 `asyncId` 計數器，seek 或換檔時 `asyncId++`，並對進行中的 async iterator 呼叫 `return()`。迴圈每次 await 之後檢查 `currentAsyncId !== asyncId` 就退出（L75、L88–L99、L291–L293、L347–L356）[已查證]。

## 2. 跨執行緒的資料：packet、PCM、VideoFrame

### 2.1 VideoFrame 的 transfer 與 close

- 規格 [已查證]：
  - `VideoFrame`、`AudioData` 是 `[Exposed=(Window,DedicatedWorker), Serializable, Transferable]`；`VideoDecoder`、`AudioDecoder` 也暴露在 DedicatedWorker（[WebCodecs `index.src.html`](https://github.com/w3c/webcodecs/blob/7be369921f9e1a9ad3e12e8f8d4080cf98d8bf92/index.src.html)）。
  - **transfer steps**：把 internal slot 搬到 data holder 之後，對來源執行 *Close VideoFrame*。所以 transfer 之後來源端不必（也不能）再 close。
  - **serialization steps**（`postMessage` 沒有放進 transfer list）：建立「同一個 media resource 的新 reference」。這時兩端各持有一個 reference，**兩邊都要 close**，否則 decoder 的 frame pool 會被佔住。
  - `decode()` 的 note：output 的 `VideoFrame` 底層資源由 `VideoDecoder` 擁有，不 close 或等 GC 會讓解碼 stall。
- 兩種繪製位置的先例：
  - **Worker 內 OffscreenCanvas**：W3C sample、libmedia 的 VideoPipeline。frame 不離開 Worker，在 Worker 內 close。
  - **跨到主執行緒畫**：libmedia 沒有 OffscreenCanvas 時，decode 與 render 一起留在主執行緒，**並沒有**「Worker 解碼、transfer 到主執行緒畫」的路徑。movi-player #28 提案的則正是 decode Worker 把 frame transfer 到主執行緒。也就是說，先例中沒有成熟實作走「Worker 解碼 + transfer 到主執行緒畫」，可行性來自規格 [推論]。
- 歸屬規則（所有先例一致）：**目前持有 frame 的一方負責 close**；被新 frame 取代、seek flush、destroy 時都要 close 手上的 frame（libmedia `swap()` [`VideoRenderPipeline.ts` L282–L292](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avpipeline/src/VideoRenderPipeline.ts#L282-L292)）。

### 2.2 packet 與 PCM

- 沒有 SAB 時，跨執行緒都是 `postMessage` 加 transfer `ArrayBuffer`（libmedia、libav.js、web-demuxer 都一樣）。transfer 是零拷貝，但 wasm heap 裡的資料要先複製出來成為獨立的 `ArrayBuffer`，才能 transfer（libmedia `serializeAVPacket`、libav.js `Packet`）[已查證]。
- 所以 demux 與音訊解碼放在不同 Worker 時，每個 packet 都要「wasm heap → ArrayBuffer → 另一個 wasm heap」複製兩次。放在同一個 Worker 的同一個 wasm instance 就沒有這兩次複製 [推論]。
- Transferable `ReadableStream` 在 Safari 要到 27 才支援（BCD `api.ReadableStream.transferable`），v1 不能用它當跨執行緒的管線 [已查證]。

## 3. 指令、取消與 wasm 的限制

### 3.1 先例的做法

| 先例 | 序列化 | seek 連發 | 取消進行中的讀取 |
|---|---|---|---|
| libmedia | 主執行緒 `await` 各 thread 的 RPC，依序呼叫 | **忽略新的 seek**：`status === SEEKING` 時 warn 後 return（[`AVPlayer.ts` L3020–L3033](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/AVPlayer.ts#L3020-L3033)） | `DemuxPipeline.stop()` 設 `IOFlags.ABORT`；`unregisterTask` 對網路 reader 呼叫 `abort()`；demux seek 前 `loop.stopBeforeNextTick()`（[`DemuxPipeline.ts` L1035–L1040、L1257–L1275](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avpipeline/src/DemuxPipeline.ts#L1035-L1040)）；`stop()` 以 `stopPending` promise 去重 |
| libav.js | 每次呼叫一個 id，沒有佇列語意 | 無 | 無，只能 `terminate()` |
| web-demuxer | msgId | 無 | stream `cancel()` → `StopReadAVPacket`；同步 XHR 本身無法中斷 |
| movi-player #28（提案） | demux 端 promise-chain mutex | generation counter 丟掉過期的 fetch | 同上 |
| Mediabunny 範例 | 無 | `asyncId++` 讓舊迴圈自行退出 | iterator `return()` |

### 3.2 對本 Engine 的含意

- map 要求的「最後一個 seek 勝出、被取代的以 AbortError 結束」，先例都沒有完整實作，需要自己設計。可以組合的元件 [推論]：
  1. 主執行緒的指令佇列負責合併（coalesce）與 AbortError，這是 Engine facade 的責任，不必放進 Worker。
  2. 每個送進 Worker 的指令帶 epoch；Worker 回傳的事件、frame、PCM 都帶 epoch，主執行緒丟掉並 close 舊 epoch 的資料。
  3. Worker 收到新 epoch 時，abort 舊 epoch 的 fetch（Worker 內有 `fetch` 與 `AbortController`），讓卡在讀取的 wasm 呼叫以錯誤返回。
- Worker 內一次只能有一個 wasm 呼叫在進行（見 §3.3），所以 Worker 內也需要一個「wasm 呼叫佇列」。佇列上的 seek 必須能讓正在等網路的 read 提早失敗，否則新的 seek 要排在舊的 read 後面。

### 3.3 Asyncify：每個 wasm instance 只能有一個 async 操作在進行

- Emscripten runtime 只有一份 `Asyncify.currData`；`whenDone()` 有 assertion：「cannot have multiple async operations in flight at once」（[`libasync.js` L255–L262](https://github.com/emscripten-core/emscripten/blob/ac0c9059fb1d62af2be2ab75388d08cf5e91a883/src/lib/libasync.js#L255-L262)）[已查證]。
- 含意 [推論]：
  - 若主檔與外掛音軌的兩個 `AVFormatContext` 共用一個 FFmpeg wasm instance，一個 demuxer 在等 fetch 時，另一個 demuxer、音訊解碼與 `atempo` 都不能進 wasm。網路慢的外掛音軌會拖住主檔的影片 demux。
  - 緩解方式有三種：
    - 預讀加快取，讓大多數 read 不需要 suspend（map 已要求預讀與 LRU）。
    - 每個 demuxer 一個 wasm instance：同一個 Worker 內可以有多個 Emscripten module instance（`MODULARIZE`），共用同一份 compiled `WebAssembly.Module`。
    - 每個 demuxer 一個 Worker。
  - 改用 JSPI 的話，限制是否相同未查證；而且 JSPI 在 Safari 要到 27（BCD `webassembly.jspi`），不在「近兩年」的支援範圍。
  - SAB 加 `Atomics.wait` 需要 COOP/COEP。
  - 這部分的選擇屬於 #4。

## 4. destroy 與記憶體回收

- `WebAssembly.Memory` 只有 `grow()`，沒有縮小的 API（BCD `webassembly.api.Memory` 的子項只有 `buffer`、`grow`、`toFixedLengthBuffer`、`toResizableBuffer`）[已查證]。Emscripten 的 `ALLOW_MEMORY_GROWTH` heap 只會變大。
- 所以一次 probe 或 seek 讓 heap 長到的高水位，會留到 instance 被丟掉為止。**要保證歸還，就要丟掉整個 instance**：放開所有 reference 讓 GC 回收（時間不保證），或 `worker.terminate()`（立即，而且連同 Worker 內所有 fetch、timer、WebCodecs 物件一起結束）[推論]。
- 先例：
  - libav.js、web-demuxer：destroy 就是 `terminate()`。
  - libmedia：Worker 是 static、跨 player 共用。`destroy()` 只呼叫各 thread 的 `unregisterTask`／`clear`，並釋放主執行緒的共享結構（[`AVPlayer.ts` L4213–L4260](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/AVPlayer.ts#L4213-L4260)）。要等 `AVPlayer.stopPipelines()` 才會 `closeThread` → `worker.terminate()`（[`thread.ts` L783–L786](https://github.com/zhaohappy/cheap/blob/85cc79e032cbd417e3bb4a218bdf26da537b970b/src/thread/thread.ts#L783-L786)）。這種設計省掉重建 Worker 與編譯 wasm 的成本，但 heap 高水位會一直保留。
- 已經 transfer 到主執行緒的 `VideoFrame` 不會因為 terminate 而被 close，主執行緒的佇列要自己 close。`AudioWorkletNode` 與 `AudioContext` 也要在主執行緒 disconnect 或 close [推論]。
- 重建成本的緩解：主執行緒用 `WebAssembly.compileStreaming` 編譯一次，再把 `WebAssembly.Module` `postMessage` 給新的 Worker，省掉重複編譯。`WebAssembly.Module` 可以 structured clone 是規格行為；Safari 實際是否支援**[未查證]**。

## 5. 平台能力（MDN BCD 8.1.5）

### 5.1 支援度

| 功能 | Chrome | Firefox | Safari / iOS | 對本專案的意義 |
|---|---|---|---|---|
| `VideoDecoder`／`VideoFrame` | 94 | 130 | 16.4 | 都可以在 Worker 內使用 |
| `AudioDecoder`／`AudioData` | 94 | 130 | **26** | map 已決定音訊走 FFmpeg wasm，不受影響 |
| `OffscreenCanvas`、`transferControlToOffscreen`、2D context | 69 | 105 | 16.4 | |
| OffscreenCanvas 的 WebGL／WebGL2 context | 69 | 105 | **17** | 與 libmedia 的 Safari 17 判斷一致 |
| `DedicatedWorkerGlobalScope.requestAnimationFrame` | 69（不支援 nested Worker） | 99 | 16.4 | |
| module Worker（`type: 'module'`） | 80 | 114 | 15（nested Worker 15.5；nested Worker 載入 script 16.4） | |
| `AudioWorklet`／`AudioWorkletNode.port` | 66 | 76 | 14.1（iOS 14.5） | |
| `SharedArrayBuffer` | 68 | 79 | 15.2 | 都需要 cross-origin isolation |
| `MediaSourceHandle`（Worker 內 MSE） | 108 | 無 | 18 | 本專案不走 MSE，僅供參考 |
| Transferable `ReadableStream` | 87 | 103 | **27** | v1 不能用 |
| WebAssembly JSPI | 137 | 153 | **27** | v1 不能當唯一的銜接方式（#4） |

### 5.2 規格與先例中的其他限制

- `AudioContext` 只能在主執行緒使用（[web-audio-api#2423](https://github.com/WebAudio/web-audio-api/issues/2423) 仍在討論是否暴露到 Worker）。AudioWorklet 可以透過 transfer 進來的 `MessagePort` 直接與 Worker 通訊（libmedia 的做法）。
- HTML 規格：canvas 的 context mode 是 *placeholder*（已經 `transferControlToOffscreen()`）時，設定 `width`／`height` 會拋 `InvalidStateError`（[HTML canvas](https://html.spec.whatwg.org/multipage/canvas.html#attr-canvas-width)）[已查證]。
  - 這代表一旦把 App 的 canvas 交給 Worker，resize 就必須經過 Engine 的 API，App 也不能再對它 `getContext()`。
  - 這與 map「畫到 app 給的 canvas（2D 或 WebGL）」的契約不同，所以 OffscreenCanvas 必須是 App 選擇的另一種模式。
- WebCodecs「Resource Reclamation」：UA **可以**回收 inactive 或 background 的 codec，以 `QuotaExceededError` close。background 指 document hidden，Worker 內的 codec 以 owner document 判斷。正在出聲的 `AudioDecoder` 不會被回收，但 `VideoDecoder` 沒有這種保護（[`index.src.html` L6228–L6270](https://github.com/w3c/webcodecs/blob/7be369921f9e1a9ad3e12e8f8d4080cf98d8bf92/index.src.html)）[已查證]。這與 map「背景停止解碼影片，回前景重新同步」的方向一致：Engine 要能處理 decoder 在背景被 close，回前景時重新 configure 並從 keyframe 開始。

## 6. iOS Safari（以及 macOS Safari）的已知問題

| 問題 | 來源 | 狀態 |
|---|---|---|
| `AudioContext` 要在 user gesture 內建立或 resume。若點擊後先 `await player.load()`（要跨 Worker 來回）再 `play()`，iOS 15 上 `AudioContext` 仍是 `suspended` | [libmedia #14](https://github.com/zhaohappy/libmedia/issues/14) | [已查證：issue 回報]；含意：解鎖 `AudioContext` 必須在主執行緒同步完成，不能放在 Worker 的回覆之後 |
| cross-origin isolated 的頁面，Safari 拒絕載入 `blob:` URL 的 Worker（「Cannot load blob:… due to access control checks」），而且建構時不會 throw，要等 `error` 事件 | [movi-player `MoviPlayer.ts` L17150–L17170 的註解](https://github.com/MrUjjwalG/movi-player/blob/8bd0b50d7cdfcef635e015ea93e365876088969d/src/core/MoviPlayer.ts#L17150-L17170) | [未查證：只有原始碼註解，沒有 WebKit bug 連結]；含意：Worker 用獨立的 script URL（`new URL('./x.worker.js', import.meta.url)`），並監聽 `error` |
| macOS Safari 在 Worker 內使用 web-demuxer（它自己再開 wasm Worker，形成 nested Worker）時出現「Not allowed to load local resource: blob:null/…」，回報者最後把載入搬回主執行緒 | [web-demuxer #8](https://github.com/bilibili/web-demuxer/issues/8)（2024-09 關閉） | [未查證：根因不明，可能與 nested Worker 加 `blob:` 有關]；含意：Engine 不要做 nested Worker；libav.js 在 Engine 的 Worker 內要用 `noworker` |
| OffscreenCanvas 的 WebGL 要 Safari 17，libmedia 因此在 Safari 17 以下把影片 pipeline 留在主執行緒 | `supportOffscreenCanvas.ts`、BCD | [已查證]；「近兩年」的 Safari 都已滿足，但 2D 繪製在主執行緒仍是最保守的預設 |
| 手機上 AudioWorklet 與其他執行緒的通訊延遲較大會造成卡頓，libmedia 的 `audioWorkletBufferLength` 在手機預設 20 個 render quantum（2560 frames），桌面是 10 | [`AVPlayer.ts` L326–L333](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/AVPlayer.ts#L326-L333)、[`AudioSourceWorkletProcessor.ts` L40](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avrender/src/pcm/AudioSourceWorkletProcessor.ts#L40) | [已查證：程式碼與註解]；數值是否適用於本專案要實測（#6） |
| libmedia 的 SAB 版 AudioWorklet processor 只在 Safari／iOS 16.1 以上使用 | [`AVPlayer.ts` L4481–L4502](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/avplayer/src/AVPlayer.ts#L4481-L4502) | [已查證]；原因沒有註解 |
| 頁面隱藏時 rAF 不會被呼叫，Worker 內的 rAF 也一樣受影響；movi-player 為此另開 timer Worker 推進背景播放 | kikoeru [mobile-background-playback research](https://github.com/mocukie/kikoeru/blob/main/docs/research/mobile-background-playback.md) §1.2、movi-player L17132 起 | Worker 內 rAF 在隱藏頁面的行為 [未查證]；含意：音訊供料不能依賴 rAF |
| iOS 只要頁面正在出聲，WebContent process 就持有 foreground assertion，main thread、dedicated Worker、wasm 都會繼續執行；停止出聲 10 秒後可能被 suspend | kikoeru mobile-background-playback research §1.2（WebKit `WebPageProxy.cpp`） | [推論，需實機驗證] |
| libav.js 文件提到「有些瀏覽器對整頁的 Worker 數量限制很低」 | [`docs/API.md`](https://github.com/Yahweasel/libav.js/blob/c05a676d16c1068cce6115594858c50a7ecad4b8/docs/API.md) | [未查證：沒有指名瀏覽器與數字]；含意：Worker 數量要少且固定，不要每個 track 或每個 decoder 開一個 |

## 7. 本 Engine 的候選架構

共同前提（所有候選都一樣）：

- 主執行緒：Engine facade、指令佇列（coalesce、AbortError）、狀態機與事件、`AudioContext` 生命週期（含在 user gesture 內同步解鎖）、音訊時鐘、A/V 同步、`navigator.audioSession` 等行動裝置掛點。
- 預設不依賴 SAB；`crossOriginIsolated` 時的加速路徑留作 [延]。
- 不使用 `blob:` Worker 與 nested Worker。Worker 以 `new URL(..., import.meta.url)` 載入 module Worker，wasm 以 `compileStreaming` 載入。
- PCM 的輸出端（AudioWorklet 經 MessagePort、或主執行緒 `AudioBufferSourceNode`）由 #6 決定。Worker 端只提供「依需求供料的 PCM port」，兩種輸出都能接上。
- 指令帶 epoch；Worker 送出的資料帶 epoch；主執行緒丟掉舊 epoch 的資料並 close 其中的 frame。

### 候選 A：每個 Engine 一個 media Worker（建議）

```
main ── Engine facade / 指令佇列 / AudioContext / clock / canvas 繪製
  │  postMessage（指令 + epoch）        ▲ VideoFrame（transfer）、事件、stats
  ▼                                      │
media Worker ── fetch + Range 快取 ── FFmpeg wasm（主檔與外掛音軌的 demuxer、音訊解碼、atempo）
             └─ VideoDecoder（WebCodecs）
  │ MessagePort（PCM，transfer ArrayBuffer）
  ▼
AudioWorklet（或主執行緒排程，見 #6）
```

- 優點：
  - demux → 音訊解碼 → `atempo` 都在同一個 wasm heap 內，packet 不必跨執行緒複製。
  - 只有一個 Worker、一個 wasm instance，記憶體上限容易控制。
  - destroy 時 `terminate()` 一次，就同時收掉 wasm heap、fetch 與 decoder。
  - 與 W3C sample、libmedia proxy 模式（IO+demux 同 Worker）的方向一致。
  - App 的 canvas 留在主執行緒，2D 或 WebGL 由 App 決定，符合 map 的契約。
  - 日後的 [延]「Worker 內 OffscreenCanvas」只要讓 App 改傳 OffscreenCanvas 進同一個 Worker，不必改執行緒結構。
- 缺點：
  - Asyncify 單一 in-flight 的限制下，外掛音軌的網路等待會拖住主檔（§3.3）。要靠預讀快取，或讓外掛音軌用第二個 wasm instance（同一個 Worker 內）。
  - 影片 demux 的突發工作量與音訊供料在同一個事件迴圈競爭，PCM 的 buffer 要留足夠深度 [推論]。
  - `VideoFrame` 要跨到主執行緒才能畫，主執行緒要維護一個小的 frame 佇列。佇列的 close 責任在主執行緒，Worker 以 credit 或 ack 控制 decode-ahead。
  - 這條「Worker 解碼 + transfer 到主執行緒畫」的路徑，先例中沒有成熟實作（§2.1），需要 prototype 驗證 Safari 上的 transfer 成本。

### 候選 B：每個來源一個 Worker（主檔 Worker + 外掛音軌 Worker）

- 主檔 Worker 的內容同候選 A；外掛音軌另開一個 Worker，有自己的 wasm instance，只做 demux、音訊解碼與 `atempo`。
- 優點：外掛音軌的網路等待完全不影響主檔；換外掛音軌就是 terminate 或建立 Worker，取消語意最乾淨；與 libav.js「一個 instance 一個 Worker」的模型一致。
- 缺點：
  - 兩份 wasm heap；compiled module 可以共用，但 heap 不行。
  - 兩條音訊來源要在主執行緒或 AudioWorklet 混音或擇一，時鐘換算（#7 的 time map 與 offset）要跨 Worker 協調。
  - Worker 數量隨外掛音軌增加。
- 適用時機：#4 選了必須 suspend 的銜接方式，而且實測預讀快取壓不住外掛音軌的等待。

### 候選 C：demux Worker 與 decode Worker 分開（libmedia SAB 模式、movi-player #28 提案）

- IO+demux 一個 Worker，音訊解碼加 `atempo` 一個 Worker，`VideoDecoder` 一個 Worker（或與音訊合併）。
- 優點：demux 的突發工作量不影響解碼；結構與 libmedia 相近，可以直接參考它的 pull 式 RPC。
- 缺點：
  - 沒有 SAB 時，每個 packet 都要複製出 wasm heap 再 transfer，進另一個 wasm heap 時又複製一次（§2.2）。
  - demux 與音訊解碼都需要 FFmpeg，等於兩份 FFmpeg wasm heap。
  - seek、切軌、destroy 要協調三個執行緒，序列化與取消最複雜。
  - 對以音訊為主、`VideoDecoder` 本身就是非同步硬體解碼的本專案，效益小 [推論]。
- 結論：不建議 v1 採用，除非 #4 選了 SAB 路線。

### 候選 D：Worker 內 OffscreenCanvas 繪製（A 的延伸，屬於 [延]）

- 在候選 A 的 media Worker 內繪製，`VideoFrame` 不離開 Worker；Worker 需要時鐘，可參考 W3C sample 由主執行緒定期推送 media time 加 `performance.now()` 外插，或由 AudioWorklet 回報已播放的 frame 數。
- 優點：主執行緒最輕，frame 的 close 責任完全在 Worker。
- 缺點：App 交出 canvas 之後不能再控制 resize 與 context（§5.2）；Worker 內 rAF 在背景的行為未查證；A/V 同步要跨執行緒推送時鐘。
- v1 的設計要做到：繪製介面放在可替換的 renderer 後面，frame 佇列的 close 規則不依賴「在哪個執行緒畫」。這樣 D 之後可以作為 App 選用的模式加入。

### 比較

| 項目 | A：單一 media Worker | B：每個來源一個 Worker | C：demux／decode 分開 |
|---|---|---|---|
| Worker 數 | 1 | 1 + 外掛音軌數 | 2–3 |
| wasm heap 份數 | 1（外掛音軌可選第 2 份） | 1 + 外掛音軌數 | 2 以上 |
| packet 跨執行緒複製 | 無 | 無 | 每個 packet 兩次 |
| 外掛音軌的網路等待影響主檔 | 會（Asyncify 時），靠快取或第二個 instance 緩解 | 不會 | 視 demux Worker 內的安排而定 |
| destroy 的保證 | terminate 一個 | terminate 全部 | terminate 全部，加上跨 Worker 的 port 清理 |
| 指令序列化的複雜度 | 低 | 中 | 高 |
| 先例 | W3C sample；libmedia proxy（IO+demux） | libav.js、web-demuxer（一個 instance 一個 Worker） | libmedia（SAB）、movi-player #28 |

## 8. 交給 #11 的待決事項與待實測項目

- **待決**：
  1. 採用候選 A 還是 B。關鍵輸入是 #4 的銜接方式：若選 Asyncify，要看單一 instance 的限制在外掛音軌情境下能否接受。
  2. Worker 跨 `load()` 重用還是每次重建。建議：同一個 Engine 內重用，`destroy()` 一律 terminate；另設 heap 高水位門檻，超過就在下次 `load()` 時重建。
  3. `VideoFrame` 佇列的深度與 credit 機制，以及背景時停止影片解碼的協定（配合 Resource Reclamation）。
- **待實測**：
  - Safari（macOS 與 iOS）上 `VideoFrame` 從 Worker transfer 到主執行緒並 `drawImage` 的成本與穩定性 [未查證]。
  - `WebAssembly.Module` 經 `postMessage` 傳給 Worker，Safari 是否支援 [未查證]。
  - iOS 鎖屏時 media Worker 的執行頻率：PCM 供料能否跟上，並與 kikoeru 的實機鎖屏清單一起測 [未查證]。
  - Worker 內 rAF 在隱藏頁面的行為（候選 D 才需要）[未查證]。
  - AudioWorklet 經 MessagePort 向 Worker pull 的延遲，以及手機上需要的 buffer 深度（與 #6 合併實測）。
  - 連續切換上百個檔案時，Worker 重用與重建兩種策略的記憶體曲線。

## 來源

- movi-player `8bd0b50d7c`：[`src/core/MoviPlayer.ts`](https://github.com/MrUjjwalG/movi-player/blob/8bd0b50d7cdfcef635e015ea93e365876088969d/src/core/MoviPlayer.ts)、[`docs/guide/troubleshooting.md`](https://github.com/MrUjjwalG/movi-player/blob/8bd0b50d7cdfcef635e015ea93e365876088969d/docs/guide/troubleshooting.md)、[issue #28](https://github.com/MrUjjwalG/movi-player/issues/28)；kikoeru 的 [`movi-player-capability.md`](https://github.com/mocukie/kikoeru/blob/main/docs/research/movi-player-capability.md)。
- libmedia `152f629d30`：`README.md`、`Changelog`、`tsconfig.json`、`packages/avplayer/src/AVPlayer.ts`、`packages/avplayer/src/worker/*Proxy.ts`、`packages/avplayer/src/worker/VideoPipeline.ts`、`packages/avplayer/src/function/supportOffscreenCanvas.ts`、`packages/avpipeline/src/{DemuxPipeline,VideoDecodePipeline,VideoRenderPipeline}.ts`、`packages/avrender/src/pcm/AudioSourceWorkletProcessor.ts`；[issue #14](https://github.com/zhaohappy/libmedia/issues/14)。
- cheap `85cc79e032`：`src/config.ts`、`src/thread/thread.ts`；common `00c9c3c481`：`src/util/support.ts`。
- libav.js `c05a676d16`：`docs/API.md`、`docs/IO.md`、`src/frontend.in.js`、`Makefile.m4`。
- W3C WebCodecs `7be369921f`：`index.src.html`（VideoFrame／AudioData 的 transfer 與 serialization、Resource Reclamation）、`samples/audio-video-player/*`、`samples/lib/audio_renderer.js`、`samples/video-decode-display/worker.js`、`samples/_headers`；[WebAudio/web-audio-api#2423](https://github.com/WebAudio/web-audio-api/issues/2423)。
- web-demuxer `91721712b0`：`src/wasm.worker.ts`、`src/web-demuxer.ts`、`lib/web-demuxer/post.js`、`Makefile`；[issue #8](https://github.com/bilibili/web-demuxer/issues/8)。
- Mediabunny `cc108b3b49`：`examples/media-player/media-player.ts`、`docs/guide/media-sinks.md`。
- Emscripten `ac0c9059fb`：[`src/lib/libasync.js`](https://github.com/emscripten-core/emscripten/blob/ac0c9059fb1d62af2be2ab75388d08cf5e91a883/src/lib/libasync.js)。
- HTML Living Standard：[canvas 的 `width`／`height` 與 placeholder](https://html.spec.whatwg.org/multipage/canvas.html#attr-canvas-width)。
- MDN browser-compat-data 8.1.5（2026-10-08，`https://unpkg.com/@mdn/browser-compat-data/data.json`）：`api.VideoFrame`、`api.VideoDecoder`、`api.AudioDecoder`、`api.AudioData`、`api.OffscreenCanvas.getContext.*`、`api.HTMLCanvasElement.transferControlToOffscreen`、`api.DedicatedWorkerGlobalScope.requestAnimationFrame`、`api.Worker.Worker.ecmascript_modules`、`api.AudioWorklet`、`api.AudioWorkletNode.port`、`javascript.builtins.SharedArrayBuffer`、`api.MediaSourceHandle`、`api.ReadableStream.transferable`、`webassembly.jspi`、`webassembly.api.Memory`。
- kikoeru：[`mobile-background-playback.md`](https://github.com/mocukie/kikoeru/blob/main/docs/research/mobile-background-playback.md) §1.2。
