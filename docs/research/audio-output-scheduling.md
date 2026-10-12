# Research：音訊輸出的排程方式

> 狀態：調查完成，建議見 §8。結論都沒有在實機上驗證過，§9 列出 prototype 與實機要確認的項目。

- 對應 issue：mocukie/kikoeru-player#6（map：#1）
- 調查日期：2026-10-12
- 問題：Worker 解碼出 float PCM 之後，要用什麼方式送進 `AudioContext`。要比較的是 `AudioBufferSourceNode`（ABSN）串接和 AudioWorklet + ring buffer 兩種作法，另外包含取樣率、iOS `interrupted`、latency 和背景執行等問題。
- 原始碼版本：
  - Web Audio API spec：Editor's Draft 2026-09-09（[`WebAudio/web-audio-api` `index.bs`](https://github.com/WebAudio/web-audio-api/blob/main/index.bs)）
  - WebKit `main` @ [`218e496`](https://github.com/WebKit/WebKit/tree/218e49659fdb8f50641ec192c8c580bd5393ef29)
  - Chromium `main` @ [`741d99f`](https://github.com/chromium/chromium/tree/741d99ffd1942b9951126ab8e9a0974073f1e84e)
  - Firefox：[`mozilla-firefox/firefox` `main`](https://github.com/mozilla-firefox/firefox/tree/main/dom/media/webaudio)（2026-10-12）
  - MDN browser-compat-data：`main`（2026-10-12）
- 方法：只看一手來源，包括 spec、瀏覽器原始碼、MDN BCD、WebKit Bugzilla、Mozilla Bugzilla，以及 Chrome、Mozilla 官方或 spec editor 寫的文章。**沒有做實機測試**。已經在 kikoeru 的 [`docs/research/mobile-background-playback.md`](https://github.com/mocukie/kikoeru/blob/main/docs/research/mobile-background-playback.md)（以下稱「背景播放 research」）查證過的部分只引用結論，不重查。
- 用語：
  - **ABSN 串接**：每段 PCM 建一個 `AudioBuffer` 和一個 `AudioBufferSourceNode`，再用 `start(when)` 一段接一段排到 `AudioContext` 的時間軸上。movi-player 採用的就是這種作法。
  - **Worklet sink**：一個 `AudioWorkletProcessor`，每個 render quantum 從自己的 ring buffer 讀 128 frame 輸出，本身不做 DSP。
  - **未隔離**：頁面沒有 cross-origin isolated（沒有送 COOP/COEP），所以拿不到 `SharedArrayBuffer`。kikoeru 後端目前就是這種狀態。

## TL;DR

1. **建議用 AudioWorklet sink + ring buffer**，資料由解碼 Worker 經過專用的 `MessageChannel` 直接送進 worklet，不經過主執行緒。所有格式轉換都在 Worker 裡用 FFmpeg（libswresample）做完，包括重採樣到 `ctx.sampleRate`、5.1 downmix、轉成 float，time-stretch 也在 Worker 做。worklet 只負責讀 ring buffer、做 fade 和回報播放位置。
2. **不建議用 ABSN 串接**，原因有三：
   - 排程由主執行緒負責。主執行緒一忙或在背景被節流，就會出現空隙或重疊。
   - pause 和 buffering 要靠 `ctx.suspend()`／`resume()`，正好撞上 spike patch 0003 處理的競爭。
   - `AudioBuffer` 的取樣率和 context 不同時，Chromium 用**線性內插**重採樣，品質不好。
3. **未隔離時，MessagePort 可以穩定供料**，前提是 ring buffer 留夠餘裕（建議 100–250 ms）。spec 規定，送往 worklet 的 message 會在每個 render quantum 之前、在 rendering thread 上處理，所以 latency 最多只差一個 quantum。代價是接收端會配置物件，造成 GC。Chrome 官方文章和 spec editor 都不建議用 postMessage 做即時串流，但這是在追求低延遲的前提下說的。播放器的 buffer 有一兩百 ms，可以吸收這些成本，實際數字仍要 prototype 量測。SAB 版本留一個介面，等頁面 cross-origin isolated 時再換上。
4. **取樣率**：`AudioContext` 可以指定 `sampleRate`。Chrome 和 Firefox 接受 3000–768000 Hz，WebKit 接受 3000–384000 Hz；與硬體取樣率不同時，瀏覽器在輸出端重採樣。建議**不要指定**，直接用裝置預設的取樣率，在 Worker 裡把 44.1k、96k、192k 的來源都轉成 `ctx.sampleRate`。理由如下：
   - 整個 session 只需要一個 context，換檔時不必重建，也就不必再要一次 user gesture。
   - 重採樣品質由引擎自己控制。
   - 避開 WebKit 在非原生取樣率下的歷史 bug（274507、219201）。
5. **iOS `interrupted`**：WebKit 從 Safari 9 開始支援，Chrome 136 起也支援。行為有幾個要注意的地方：
   - WebKit 的 `state` 要等底層操作完成後才更新，所以會落後於 `suspend()`／`resume()` 的呼叫。這就是 patch 0003 遇到的問題。
   - WebKit 會依呼叫順序串行執行 suspend 和 resume。
   - 在 interrupted 狀態下呼叫 `resume()`，WebKit 不會 reject，promise 會一直掛著，直到 context 回到 running；Chrome 則會 reject。
   - 引擎的作法：自己維護一條指令佇列，不看 `state`，`resume()` 要加 timeout，並用 worklet 的 frame 計數判斷 context 是否真的在跑，作為 watchdog。
6. **latency**：
   - `outputLatency` 的支援：Chrome 102、Firefox 70、Safari 18.4 起。Chrome 在沒有麥克風權限時會量化到 8 ms；Safari 不在播放時回傳 0，開啟 fingerprinting 保護時回傳固定的 512/sampleRate。
   - `getOutputTimestamp()` 的支援比較廣（Chrome 57、Firefox 70、Safari 14.1 起）。Chromium 的 `contextTime` 已經扣掉硬體延遲。
   - A/V 同步建議以 `getOutputTimestamp()` 為主，再加上使用者可以調整的 A/V offset。
7. **背景與鎖屏**：AudioWorklet 的 `process()` 由音訊 rendering thread 呼叫，所以 context 不被 interrupt 就會繼續執行。iOS 要設定 `audioSession.type = "playback"`，Android Chrome 預設就不會因為頁面隱藏而暫停，見背景播放 research。ABSN 串接在背景還需要主執行緒的 timer 準時觸發；Worklet sink 只需要 Worker 能執行，主執行緒不在關鍵路徑上，這是 Worklet sink 在背景比較穩的主要原因。

---

## 1. 兩種作法的比較

### 1.1 時鐘與排程

兩種作法都以 `AudioContext` 的 rendering 時鐘當主時鐘，沒有「生產者與消費者時鐘漂移」的問題。差別在於誰要準時做事。

- **ABSN 串接**：主執行緒必須在 `currentTime` 追上之前呼叫 `start(when)`。spec 規定 `when` 小於 `currentTime` 時「the sound will start playing immediately」（[`start(when)`](https://webaudio.github.io/web-audio-api/#dom-audioscheduledsourcenode-start)），所以只要晚一點排程，就會變成與前一段重疊，或在兩段之間留下空隙，而且之後的時間軸都會跟著錯開。資料流是 Worker → `postMessage` → 主執行緒建立 `AudioBuffer` → 主執行緒排程，每一步都會受主執行緒的工作量（UI、GC、字幕 parse）和背景節流影響。
- **Worklet sink**：rendering thread 每個 quantum 呼叫一次 `process()`，從 ring buffer 讀出 128 frame（[render quantum 預設 128](https://webaudio.github.io/web-audio-api/#render-quantum)）。只要 ring buffer 不空，就不會有空隙。Worker 只需要大致維持水位即可，不需要準時。

### 1.2 接縫爆音

- ABSN：spec 規定 `when` 「the exact value of `when` is always used without rounding to the nearest sample frame」，對不準 sample 的起點會用內插處理（[§1.9 AudioBufferSourceNode 的 subsample offset 圖例](https://webaudio.github.io/web-audio-api/#AudioBufferSourceNode)）。如果每段的 `when` 是用浮點數累加出來的，誤差就可能讓接縫處多出或少掉一個 sample，或者被內插，產生微小的 click。
  - Chromium 會把離整數 frame 只差 10 ULP 以內的起點視為整數，以容忍這種誤差（[`audio_buffer_source_handler.cc`](https://github.com/chromium/chromium/blob/741d99ffd1942b9951126ab8e9a0974073f1e84e/third_party/blink/renderer/modules/webaudio/audio_buffer_source_handler.cc) 的 tolerance 註解）。其他引擎是否有類似處理，**未查證**。
  - 如果採用 ABSN，`when` 必須用整數 frame 計數換算，例如 `when = baseTime + frameIndex / sampleRate`，不能累加 `duration`。
- Worklet sink：ring buffer 裡是連續的 sample，沒有接縫可言。換軌或 seek 的接點由 worklet 自己做 fade（§1.4），sample 精準。

### 1.3 重採樣

- spec 對 ABSN 的規定是「Resampling of the buffer may be performed arbitrarily by the UA」，`AudioBuffer` 與 context 的取樣率不同時，會換算成 computed playback rate（[§1.9 sample rate interpolation 圖例](https://webaudio.github.io/web-audio-api/#AudioBufferSourceNode)）。
- **Chromium 的 ABSN 只要 computed playback rate 不是 1，就會走線性內插**（`ProcessInterpolatedPath()` 的「Linear interpolation」）。原始碼註解也承認「linear interpolation aliasing」（[`audio_buffer_source_handler.cc`](https://github.com/chromium/chromium/blob/741d99ffd1942b9951126ab8e9a0974073f1e84e/third_party/blink/renderer/modules/webaudio/audio_buffer_source_handler.cc)）。所以把 44.1k 的 `AudioBuffer` 直接丟進 48k 的 context，在 Chrome 上的音質不如正式的重採樣器。
- 相對地，context 本身的取樣率與硬體不同時，輸出端的重採樣用的是較好的重採樣器：WebKit 用 `MultiChannelResampler`（[`AudioDestinationResampler.cpp`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/platform/audio/AudioDestinationResampler.cpp)）。不過 spec 也提醒「If resampling is required, the latency of context may be affected, possibly by a large amount」。
- 結論：**兩種作法都應該在 Worker 裡先轉成 `ctx.sampleRate`**，讓 ABSN 的 playback rate 固定為 1，或讓 worklet 不必處理重採樣。FFmpeg 的 libswresample 本來就在 wasm build 裡，授權是 LGPL，可以同時處理 downmix 和格式轉換。

### 1.4 seek 與暫停時的 gain ramp

- **AudioParam 自動化在各瀏覽器的表現不一致**：
  - MDN BCD 把 Firefox 的 `linearRampToValueAtTime()`／`exponentialRampToValueAtTime()` 標成 partial，原因是「Sometimes jumps to value immediately」（[Mozilla bug 2011524](https://bugzilla.mozilla.org/show_bug.cgi?id=2011524)，NEW）。
  - BCD 也把 Chrome Android 標成「Behaves like `setValueAtTime()`」。這個註記沒有附 bug 連結，**未驗證**，可能是舊版本的資料。
  - 常見的保險寫法是先 `cancelScheduledValues(t)`，再 `setValueAtTime(current, t)`，最後才 ramp。
- **ABSN 串接**：seek 時要把所有已排程的 node 在 ramp 結束時 `stop()` 掉，引擎必須追蹤每個 node。暫停時，movi-player 的作法是 `ctx.suspend()`，好處是保留已排程的 node，但會碰上 §4 的 suspend／resume 競爭。
- **Worklet sink**：fade 在 worklet 裡逐 sample 計算。例如收到 `flush` 指令後，用 5–20 ms 淡出再清空 ring buffer，新資料進來時再淡入。這樣不依賴 AudioParam 自動化，而且 sample 精準。暫停也是淡出之後輸出靜音並停止讀取，context 保持 running，**不需要呼叫 `suspend()`**。音量與靜音可以用 worklet 後面接的 `GainNode`，搭配 `setTargetAtTime()`。這個方法沒有 BCD 的 partial 註記，各瀏覽器都從早期版本就支援。
- 長時間暫停（例如超過 30 秒）時，可以再呼叫 `ctx.suspend()` 省電。這次呼叫要經過引擎的指令佇列（§4.3）。

### 1.5 delay（音軌 offset）與變速

- **delay**：兩種作法都只是在時間戳上平移，不需要 `DelayNode`。
  - Worklet sink：Worker 送資料時改寫 PTS 對應；delay 為正時，先送一段靜音。
  - ABSN：平移 `when`。
  - 外掛音軌與容器內的音軌都適用。
- **不變調變速**：spec 的 ABSN `playbackRate` 會同時改變速度和音高（同上 §1.9 的 playbackRate interpolation），Web Audio 也沒有 `preservesPitch`。所以兩種作法都要自己做 time-stretch（SoundTouch 或 Signalsmith Stretch，由另一張 ticket 決定）。
  - 放在 Worker：Worker 的輸出就是已經變速的 PCM，worklet 不需要知道速度。缺點是改速度之後，要等 ring buffer 裡舊速度的資料播完才生效。解法是改速度時發出 `flush`：worklet 回報實際播到的 media 位置，Worker 從那個位置用新速度重新產生資料。這需要 Worker 保留一小段已解碼的 PCM。
  - 放在 worklet：AudioWorkletGlobalScope 可以執行 wasm。Chrome 的文章建議在 worklet 裡同步編譯，或從主執行緒傳入已編譯好的 module（[Audio worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)）。這種放法改速度會立即生效，但 stretch 的運算會吃掉每個 quantum 的時間預算。以 44.1 kHz 計算約 3 ms（同一篇文章）。
  - 建議 v1 先放在 Worker，搭配 flush 機制。
  - ABSN 串接也只能在 Worker 做 time-stretch，改速度時同樣要 stop 掉已排程的 node 再重排，比 worklet 的 flush 麻煩。
- **時鐘換算**：變速之後，media time 與 context time 不再是固定比例。Worklet sink 可以讓 worklet 定期回報「這個 quantum 第一個 sample 的 media PTS」和 `currentFrame`，主執行緒只要做線性插值即可（§5.3）。ABSN 則要自己維護一張「排程段落 ↔ media 時間」的對照表。

## 2. Worker → AudioWorklet 的資料傳遞

### 2.1 拓撲

- AudioWorklet 的 API 只能從主執行緒使用，但資料不需要經過主執行緒：
  1. 主執行緒建立 `MessageChannel`。
  2. `port1` 用 `node.port.postMessage({ port }, [port])` 傳給 processor；`port2` 用 `worker.postMessage(..., [port2])` 傳給解碼 Worker。
  3. 之後 Worker 和 worklet 直接互傳資料。
- 依據：`AudioWorkletNode.port` 與 `AudioWorkletProcessor.port` 都是一般的 `MessagePort`（spec [`AudioWorkletNode`](https://webaudio.github.io/web-audio-api/#AudioWorkletNode)），而 `MessagePort` 是 HTML 的 transferable object。
- `processorOptions` 走的是 structured clone，不能 transfer，所以 port 要另外用 `postMessage` 送。
- **未在 Safari 上實測** worklet 端收到 transferred `MessagePort` 的行為，列入 §9。

### 2.2 沒有 SharedArrayBuffer 時

- `SharedArrayBuffer` 與 shared `WebAssembly.Memory` 都要求頁面 secure context 而且 cross-origin isolated。沒有隔離時，`postMessage()` 遇到 SAB 會 throw（[MDN `SharedArrayBuffer` Security requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements)）。所以在 kikoeru 目前的部署下，Chrome 文章推薦的「Worker + SAB + Atomics + ring buffer」模式（[Audio worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)）用不了。
- **MessagePort 版 ring buffer**：
  - ring buffer 是 processor 自己持有的 `Float32Array`。Worker 用 transfer 送 `Float32Array` chunk，不複製，建議每塊 2048–8192 frame。worklet 在 `onmessage` 裡把資料複製進 ring buffer。
  - **流量控制**：worklet 每 N 個 quantum（例如約 50 ms）回報一次已消耗的 frame 數和目前水位，Worker 依此補料，目標水位例如 150 ms，低水位 50 ms。
  - **buffer 回收**：worklet 把用完的 `ArrayBuffer` transfer 回 Worker 重複使用，避免持續配置新的 `ArrayBuffer`。
- **message 何時被處理**：spec 的 rendering loop 在每個 render quantum 開始時，會先處理 control message queue，再處理「associated task queue」，也就是從 `AudioWorkletNode` 送來的 task，接著才 render（[§2 Rendering an audio graph](https://webaudio.github.io/web-audio-api/#rendering-loop)）。這帶來三個結果：
  - message 最多晚一個 quantum 被處理，約 2.7–2.9 ms。
  - `onmessage` 的執行時間算在 rendering thread 的預算內，所以 handler 只能做複製和更新 index。
  - **依 spec 推論**：context 處於 `suspended` 時 rendering loop 不會執行，送往 worklet 的 message 會累積到 resume 之後才處理。Worker 要依水位回報補料，不能盲目推送。實作是否完全照這個模型執行，**未驗證**。
- **GC 與延遲**：
  - Chrome 的文章說 messaging「suboptimal for real-time audio processing because of repetitive memory allocation and messaging latency」（[Audio worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)，2018）。
  - spec editor Paul Adenot 也指出，structured clone「creates new JavaScript objects on its receiving end」，而 GC「not deterministic」，所以不建議用 postMessage 持續送資料給即時執行緒（[A wait-free single-producer single-consumer ring buffer for the Web](https://blog.paul.cx/post/a-wait-free-spsc-ringbuffer-for-the-web/)，2022-06-06）。
  - 這些批評針對的是低延遲的互動音訊。播放器的情況不同：
    - ring buffer 有一兩百 ms 的餘裕，message 晚到幾 ms 不會造成 underrun。
    - 真正的風險是 worklet thread 上的 GC 暫停：GC 會直接阻塞 `process()`，buffer 再大也無法吸收。回收 buffer 可以把每個 message 的配置壓到只剩 event 物件，但不能完全避免。
    - 一般 minor GC 的耗時是否遠小於硬體 callback 的週期，**沒有一手數據**，要用 prototype 量測。可以用 Chrome 146 起的 `AudioContext.playbackStats`（MDN BCD）或自己計算 underrun 次數。
- **何時改用 SAB**：如果日後頁面 cross-origin isolated，例如 demux 的銜接方式（另一張 ticket）選了 SAB + Atomics，就把傳輸層換成 SAB ring buffer，例如 [ringbuf.js](https://github.com/padenot/ringbuf.js)。所以 Worklet sink 的傳輸層要做成可替換的介面。

## 3. AudioContext 的取樣率

### 3.1 能不能指定

- spec：`new AudioContext({ sampleRate })`。沒有指定時，使用「the preferred sample rate of the output device」；指定的值與裝置不同時，UA「MUST resample the audio output to match the sample rate of the output device」。必須支援 3000–768000 Hz，超出範圍時丟 `NotSupportedError`（[§2.4 Supported Sample Rates](https://webaudio.github.io/web-audio-api/#sample-rates)、[`AudioContextOptions.sampleRate`](https://webaudio.github.io/web-audio-api/#dom-audiocontextoptions-samplerate)）。
- 各引擎實際接受的範圍：

  | 引擎 | 範圍 | 來源 |
  |---|---|---|
  | Chromium | 3000–768000 | [`audio_utilities.cc`](https://github.com/chromium/chromium/blob/741d99ffd1942b9951126ab8e9a0974073f1e84e/third_party/blink/renderer/platform/audio/audio_utilities.cc) `Min/MaxAudioBufferSampleRate()` |
  | Firefox | 3000–768000 | [`WebAudioUtils.h`](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/webaudio/WebAudioUtils.h) `MinSampleRate`／`MaxSampleRate` |
  | WebKit | **3000–384000** | [`BaseAudioContext.cpp`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/Modules/webaudio/BaseAudioContext.cpp) `isSupportedSampleRate()` |

- `sampleRate` 選項的支援（MDN BCD `api/AudioContext.json`）：Chrome 74、Firefox 61、Safari 14.1 起，iOS 跟隨 Safari。

### 3.2 iOS Safari

- WebKit 以 `AVAudioSession` 的 `sampleRate` 作為硬體取樣率（`AudioSessionIOS::sampleRate()`），context 的取樣率與它不同時，加上 `MultiChannelResampler`（[`AudioDestinationCocoa.cpp`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/platform/audio/cocoa/AudioDestinationCocoa.cpp)、[`AudioDestinationResampler.cpp`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/platform/audio/AudioDestinationResampler.cpp)）。
- 在 [`AudioSessionIOS.mm`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/platform/audio/ios/AudioSessionIOS.mm) 裡找不到 `setPreferredSampleRate`，只有 `setPreferredIOBufferDuration`。也就是說，**指定 `sampleRate` 不會改變 iPhone 的硬體取樣率**，只會多一層重採樣。iPhone 的硬體取樣率通常是 48 kHz，這點**未查到 Apple 文件**。
- 相關的 WebKit bug：
  - [274507](https://bugs.webkit.org/show_bug.cgi?id=274507)（FIXED）：iPadOS 17.5 的 regression，`sampleRate: 44100` 加上 AudioWorklet 時聲音失真。2024-05-28 修正（279409@main），並 cherry-pick 到 `safari-7618` branch。
  - [219201](https://bugs.webkit.org/show_bug.cgi?id=219201)（RESOLVED）：context 取樣率與硬體不同時音質差。
  - [258864](https://bugs.webkit.org/show_bug.cgi?id=258864)（NEW）：iOS 切到藍牙喇叭後，硬體取樣率改變，Web Audio 失真而且速度錯誤。Jer Noble 認為與 259899 重複，並表示 STP 178 已修好。2024-07 有人回報 AudioWorklet 在 48 kHz 時仍有類似問題，改用 ABSN 之後就沒有了，這點**未驗證**。
  - [226240](https://bugs.webkit.org/show_bug.cgi?id=226240)（NEW）：iOS 上 AudioWorklet 播放有雜音。可能是 251091（FIXED）的重複，根本原因沒有釐清。
  - 從這些 bug 來看，**iOS 上 AudioWorklet 的音質是 Worklet sink 最大的風險**，必須用實機驗證（§9）。

### 3.3 44.1k／96k／192k 來源的處理（建議）

1. 建立 `AudioContext` 時**不指定** `sampleRate`，整個 Engine 生命週期只用這一個 context。
2. Worker 用 libswresample 把每個來源轉成 `ctx.sampleRate`，同時做 downmix（5.1 → stereo，或依 `destination.maxChannelCount`）和轉 float。所以換檔、換外掛音軌時，不需要重建 context。
   - 重建 context 在 Safari 和 Chrome 上都要再次通過 autoplay 或 user gesture 的檢查。MDN BCD 的 Safari 註記是「New audio contexts are suspended until the `resume()` method is called via user action」。
   - 在 iOS 上，重建 context 還會牽動 audio session 和 Now Playing（見背景播放 research）。
3. 192 kHz 的來源先在 Worker 降到 48 kHz，可以省下 worklet 與 ring buffer 四倍的記憶體和頻寬。
4. 硬體取樣率在播放中改變時（藍牙切換），`ctx.sampleRate` 不會變，由瀏覽器處理。WebKit 在這種情況下有 258864 這類問題，Engine 能做的只有偵測（§4.3 的 watchdog）和提供「重建 context」的復原路徑。

## 4. iOS `interrupted` 與 suspend／resume 的競爭

### 4.1 spec 與各引擎的支援

- spec 定義 `AudioContextState` 為 `"suspended"`、`"running"`、`"closed"`、`"interrupted"`。interruption 是「an event generated by the user agent when it needs to halt audio playback」，例如其他 app 要求獨占音訊硬體（[§2 Handling an interruption on the AudioContext](https://webaudio.github.io/web-audio-api/#interruption-handling)）。interruption 結束時，context 會回到中斷前的狀態（`[[state before interruption]]`）。context 原本是 suspended 時，進入 interrupted 不會觸發 `statechange`，理由是「for privacy reasons」。
- spec 規定 `state` 回傳 `[[control thread state]]`，而 `suspend()` 會同步把它設成 `suspended`（[`suspend()`](https://webaudio.github.io/web-audio-api/#dom-audiocontext-suspend) step 5）。照 spec 來說，呼叫後立刻讀 `state` 就會看到新值。
- MDN BCD 的 `interrupted` 值：Safari 9、Chrome 136 起支援，Firefox 不支援。

### 4.2 WebKit 的實際行為

以下出自 [`AudioContext.cpp`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/Modules/webaudio/AudioContext.cpp) 與 [`BaseAudioContext.cpp`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/Modules/webaudio/BaseAudioContext.cpp)：

- **`state` 落後於呼叫**：
  - `suspendRendering()`／`resumeRendering()` 不會同步改 `state`，要等 destination 的 `suspend`／`resume` callback 回來、排入 task 之後，才呼叫 `setState()`。
  - 所以呼叫 `suspend()` 之後馬上讀 `state`，讀到的仍然是 `"running"`。這與 spec 不同，也是 [spike patch 0003](https://github.com/mocukie/kikoeru/blob/prototype/154-player-spike/src/main/webui-player-spike/movi/patches/0003-audio-context-suspend-resume-race.patch) 遇到的問題：movi-player 用 `state === "suspended"` 決定要不要 `resume()`，結果讀到舊值而跳過 resume，新的 source 就沒有聲音。
- **呼叫依序執行**：`suspendRendering()` 和 `resumeRendering()` 都接在 `m_currentRenderingOperation` 這個 promise 鏈後面（`whenSettled(...)`），所以依呼叫順序串行執行。patch 0003 的註解「The calls themselves apply in call order」與此一致。這是 WebKit `main` 的實作，何時加入**未查證**。
- **在 interrupted 時呼叫 `resume()`**：`willBeginPlayback()` 回傳 false，或 resume 完成時發現仍在 interrupted，WebKit 會把 promise 掛在 `addReaction(State::Running, ...)` 上，**直到 context 回到 running 才 resolve，不會 reject**。如果中斷一直沒有結束，這個 promise 就永遠不會完成。背景播放 research 提到的 WebKit bug 281566（「`resume()` 永遠不會 resolve」）也屬於這一類。
- **中斷結束時**：`AudioContext::resume(ReasonForSuspension)` 以 `MayResumePlaying` 結束中斷。原本在播放的 context 可能會被 WebKit 自動恢復。
- **鎖屏的 play／pause**：直接呼叫 `mayResumePlayback()`／`suspendPlayback()`，不經過 JS（背景播放 research §1.3）。Engine 只能從 `statechange` 得知。
- **仍未修好的 bug**（背景播放 research §1.1）：
  - [263627](https://bugs.webkit.org/show_bug.cgi?id=263627)：顯示 `running`，但 `currentTime` 不再前進。
  - [283419](https://bugs.webkit.org/show_bug.cgi?id=283419)：其他 app 發聲之後，`running` 但沒有聲音。
  - 兩者的 workaround 都是 `suspend()` 再 `resume()`。

### 4.3 Chromium

- `resume()` 遇到 `interrupted` 時直接 reject，訊息是「Cannot resume an interrupted AudioContext.」（[`audio_context.cc`](https://github.com/chromium/chromium/blob/741d99ffd1942b9951126ab8e9a0974073f1e84e/third_party/blink/renderer/modules/webaudio/audio_context.cc) `ResumeError::kInterrupted`）。
- Chromium 觸發 interruption 的地方，只有 frame 隱藏而且 permissions policy `media-playback-while-not-visible` 不允許的情況。這個 policy 預設允許，所以一般頁面不會進入 interrupted。
- `suspend()` 改為非同步轉換，由 runtime flag `AudioContextAsyncStateTransitions` 控制，啟用時 `state` 也會晚一步更新。

### 4.4 對 Engine 的要求（v1 的 state machine）

1. **所有 `suspend()`、`resume()`、`close()` 都經過 Engine 自己的串行佇列**，送出前不看 `state`，與 patch 0003 的作法相同。每個呼叫都加 timeout（例如 2 秒）。逾時的 `resume()` 視為「等待中斷結束」，不要 await 到底。
2. **`state` 只當作提示**。真正的「有沒有在出聲」由 worklet 判斷：worklet 每約 250 ms 回報一次 `currentFrame` 和輸出的峰值。主執行緒在 Engine 狀態為 `playing` 時，如果超過門檻（例如 1 秒）沒有收到新的 frame，就判定 context 停住，執行 `suspend()` 再 `resume()`，對應 263627 與 283419。還是不行，就重建 context，作為最後手段。這是 Worklet sink 比 ABSN 方便的地方：ABSN 只能看 `currentTime`，而 263627 的症狀正是 `currentTime` 停住，`state` 卻顯示 running。
3. 收到 `statechange` 且值為 `interrupted` 時，Engine 轉為 `paused`，並發出帶原因的事件。中斷結束、context 回到 `running` 之後，**不自動恢復播放**，由 App 決定。原因是 WebKit 的鎖屏 play 會自己 resume context，Engine 要以 Engine 狀態為準，必要時再 suspend 回去。這部分屬於 state machine 的細節，交給 grilling ticket 決定。
4. pause 和 buffering 不使用 `suspend()`（§1.4），可以大幅減少 suspend／resume 的呼叫次數，也就減少競爭的機會。

## 5. `outputLatency`／`baseLatency` 與 A/V 同步

### 5.1 定義（spec）

- `baseLatency`：從 `AudioDestinationNode` 交給 audio subsystem 的處理延遲，「does not include any additional latency ... between the output of the AudioDestinationNode and the audio hardware」。
- `outputLatency`：從 UA 請求播放 buffer，到第一個 sample 實際從裝置發出聲音的時間。這個值「may change while the context is running」，spec 建議「query this value frequently」。
- `getOutputTimestamp()`：`contextTime` 是「the sample frame which is currently being rendered by the audio output device」，`performanceTime` 是對應的 `performance.now()` 時間。spec 特別提醒，`currentTime` 減 `contextTime` 不能當作 latency 的估計。

來源：[`AudioContext` attributes](https://webaudio.github.io/web-audio-api/#AudioContext-attributes)、[`getOutputTimestamp()`](https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)

### 5.2 支援與可信度

| | Chrome | Firefox | Safari／iOS | 備註 |
|---|---|---|---|---|
| `baseLatency` | 58 | 70 | 14.1 | WebKit 的算法是 `framesPerBuffer / sampleRate` |
| `outputLatency` | 102 | 70 | **18.4** | 見下 |
| `getOutputTimestamp()` | 57 | 70 | 14.1 | |

版本來源：MDN BCD `api/AudioContext.json`

- **Chromium**：
  - `outputLatency` 是 audio callback 回報的 `delay`，也就是硬體的 playout delay。沒有麥克風權限時，會量化到 8 ms（`kOutputLatencyQuatizingFactor = 0.008`，理由是隱私）；有權限時精度為 1 ms。
  - `getOutputTimestamp().contextTime` 的計算方式是 `frames_elapsed / sampleRate - delay`，**已經扣掉硬體延遲**，不要再減一次 `outputLatency`。
  - 來源：[`audio_context.cc`](https://github.com/chromium/chromium/blob/741d99ffd1942b9951126ab8e9a0974073f1e84e/third_party/blink/renderer/modules/webaudio/audio_context.cc)、[`audio_destination.cc`](https://github.com/chromium/chromium/blob/741d99ffd1942b9951126ab8e9a0974073f1e84e/third_party/blink/renderer/platform/audio/audio_destination.cc)
- **WebKit**：
  - `outputLatency` 在 context 不在播放時回傳 `0`。開啟 noise injection policy（fingerprinting 保護）時，回傳固定的 `512 / sampleRate`。其他情況回傳 AudioOutputUnit 與 `AVAudioSession` 兩者的 latency 之和（[`AudioContext.cpp`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/Modules/webaudio/AudioContext.cpp)、[`AudioDestinationCocoa.cpp`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/platform/audio/cocoa/AudioDestinationCocoa.cpp)）。哪些情境會啟用 noise injection，**未逐一查證**，例如 Private Browsing 或 Advanced Fingerprinting Protection。
  - `getOutputTimestamp()` 會把 `contextTime` 限制在不超過 `currentTime`，`performanceTime` 使用 reduced resolution。`contextTime` 是否扣掉了裝置延遲，從讀到的程式碼無法確定，**未驗證**。
- **藍牙耳機**：latency 常在 100 ms 以上。各平台回報的值是否包含藍牙 codec 的延遲，**沒有一手資料**。

### 5.3 建議的同步算法

- **音訊時鐘**：
  1. worklet 每約 50–250 ms 回報一次 `{ frame: currentFrame, pts: 這個 quantum 第一個 sample 的 media 時間, rate }`。
  2. 主執行緒呼叫 `getOutputTimestamp()`，取得「正在發聲的 context 時間」與對應的 `performanceTime`。
  3. 用最近的回報做線性換算，得到「現在聽到的 media 時間」。
- **沒有 `getOutputTimestamp()` 或回傳 0 時**（剛開始播放時，spec 規定兩個欄位都是 0），改用 `currentTime - outputLatency`；`outputLatency` 也沒有時，用 `currentTime - baseLatency`。
- **影片 frame 的呈現**：以 `performanceTime` 為基準，換算到 rAF 的時間戳。
- **使用者的 A/V offset**：map 已經把音軌 delay 列為必做項目，同一個值也能用來補償平台回報不準的 latency。這是 v1 唯一可靠的保底手段。
- Safari 18.4 以前沒有 `outputLatency`。kikoeru 的支援範圍是近兩年，所以 iOS 18.4 以前的版本只能靠 `baseLatency` 加上手動 offset。

## 6. 背景與鎖屏時 AudioWorklet 是否持續執行

- **機制**：
  - `process()` 由 rendering thread 在 render quantum 時呼叫（spec §2 rendering loop）。WebKit 的 AudioWorklet thread 在 real-time context 下以 `QOS::UserInteractive` 建立（[`AudioWorkletThread.cpp`](https://github.com/WebKit/WebKit/blob/218e49659fdb8f50641ec192c8c580bd5393ef29/Source/WebCore/Modules/webaudio/AudioWorkletThread.cpp)）。
  - Firefox 的 AudioWorklet 在專用的 real-time thread 上執行（[High Performance Web Audio with AudioWorklet in Firefox](https://hacks.mozilla.org/2020/05/high-performance-web-audio-with-audioworklet-in-firefox/)）。
  - 所以 AudioWorklet 是否繼續執行，**完全取決於 `AudioContext` 有沒有被 suspend 或 interrupt**，與頁面是否可見沒有直接關係。
- **iOS Safari**：要設定 `navigator.audioSession.type = "playback"`（iOS 17.5／18 起確定有效），或採用 MSADN 路由（`AudioContext` 只輸出到 `MediaStreamAudioDestinationNode`，再交給 `<audio>.srcObject`），context 才不會在背景被 interrupt。只要還在出聲，WebContent process 就保有 foreground assertion，dedicated Worker 和 wasm 也會繼續執行（背景播放 research §1.1、§1.2）。所以 Worklet sink 加解碼 Worker 的組合，在背景可以持續供料。
- **Android Chrome**：context 預設不因頁面隱藏而暫停；出聲中的頁面只受最輕度的 timer 節流（背景播放 research §2.1）。Chrome 在背景能存活多久，取決於有沒有 foreground service，也就是靜音 anchor `<audio>`，這與排程方式無關。
- **兩種作法的差異**：
  - ABSN 串接需要主執行緒在背景準時觸發 timer 並建立 node。頁面隱藏時 rAF 停止，timer 也可能被節流。movi-player 的 changelog 就曾為此加入「un-throttled background decode timer」。
  - Worklet sink 的關鍵路徑是 Worker → worklet，不經過主執行緒。主執行緒在背景只需要處理狀態事件。
- **未驗證**：
  - iOS 與 Android 的 dedicated Worker 在背景時，timer 和 message 的實際頻率（背景播放 research §5 也列為未驗證）。
  - iOS 上 AudioWorklet 在鎖屏下長時間播放的穩定性與耗電，與 §3.2 的雜音 bug 有關。

## 7. 比較表

| 面向 | ABSN 串接 | AudioWorklet sink + ring buffer（MessagePort） |
|---|---|---|
| 瀏覽器支援 | 全部（Safari 6 起） | Chrome 66、Firefox 76、Safari 14.1 起，需要 secure context（`audioWorklet` 是 `[SecureContext]`） |
| 時鐘 | context 時鐘；主執行緒排程晚了就出現空隙或重疊 | context 時鐘；只要 ring buffer 不空就沒有空隙 |
| 關鍵路徑上的執行緒 | Worker → **主執行緒** → rendering | Worker → rendering（worklet） |
| 接縫 | `when` 是 sub-sample 精度，要用整數 frame 換算 | 連續的 sample，沒有接縫 |
| 重採樣 | buffer 與 context 取樣率不同時，Chromium 用線性內插 | 在 Worker 用 libswresample 轉成 `ctx.sampleRate` |
| seek／pause 的 ramp | AudioParam 自動化（Firefox bug 2011524）加上追蹤並 stop 所有 node；pause 要用 `suspend()` | worklet 內逐 sample fade；pause 不需要 `suspend()` |
| delay | 平移 `when` | 平移 PTS 對應或補靜音 |
| 變速（time-stretch） | 在 Worker 做；改速度要重排所有 node | 在 Worker 做加 flush；或在 worklet 做，立即生效 |
| 停住偵測 | 只能看 `currentTime`（263627 的症狀正是它停住） | 有 worklet 的 frame 計數與峰值作為心跳 |
| GC | 主執行緒每段都要配置 `AudioBuffer` 和 node，不在 rendering thread 上 | worklet 端每個 message 都有少量配置，**GC 發生在 rendering thread** |
| 已知風險 | spike 的 suspend／resume 競爭（patch 0003）；movi-player 的實作經驗 | iOS AudioWorklet 雜音（226240、258864 的留言）；MessagePort 下 GC 的實際影響要量測 |
| 實作量 | 低（movi-player 有現成的作法可以參考） | 中：processor、傳輸協定、流量控制、時鐘回報 |
| 未來升級 | 很難改成 SAB | 可以把傳輸層換成 SAB ring buffer |

## 8. 建議

1. **v1 採用 AudioWorklet sink + ring buffer**：
   - 傳輸層做成介面，v1 實作 MessagePort 版，由解碼 Worker 直接連到 worklet。
   - 日後頁面 cross-origin isolated 時，再加 SAB 版本。
2. **格式轉換全部在 Worker 完成**：重採樣到 `ctx.sampleRate`、downmix、24／32 bit 與 PCM 轉 float，以及 time-stretch。worklet 只做讀取、fade、靜音填補與位置回報。
3. **整個 Engine 只用一個 `AudioContext`，不指定 `sampleRate`**。在 user gesture 中建立或 resume，換檔時不重建。
4. **音量與靜音用 worklet 後面的 `GainNode`**，搭配 `setTargetAtTime()`；**seek、pause、換軌的淡入淡出在 worklet 內做**；pause 和 buffering 不呼叫 `suspend()`，只有長時間暫停才在佇列中 `suspend()`。
5. **AudioContext 的 state machine**：
   - 串行指令佇列，不看 `state`。
   - 每個呼叫加 timeout。
   - 監聽 `statechange` 並處理 `interrupted`。
   - 以 worklet 心跳做 watchdog，依序嘗試 `suspend()`+`resume()`，最後重建 context。
6. **A/V 同步**：主要用 `getOutputTimestamp()`，其次用 `outputLatency`，再其次用 `baseLatency`，另外提供使用者 A/V offset。
7. **ABSN 串接只保留作為 fallback 的選項**。如果實機驗證發現某個 iOS 版本的 AudioWorklet 音質無法接受（§3.2），可以讓同一個傳輸介面多一個「主執行緒 ABSN sink」實作。v1 先不做，但介面不要把它堵死。

## 9. 未驗證事項與要 prototype／實機確認的項目

- **全部結論都沒有實機驗證**。WebKit 和 Chromium 讀的是 2026-10-12 的 `main`，已發行的版本可能落後。
- **MessagePort 供料的實測**：在 Chrome、Firefox、iOS Safari 上，量測 GC 暫停對 worklet 的影響、underrun 次數，以及最小可行的 ring buffer 水位。Chrome 可以用 `playbackStats`；其他瀏覽器在 worklet 內自己計算 underrun。
- **Safari 的 worklet 端能否收到 transferred `MessagePort`**，以及 Worker 直接連到 worklet 的路徑能否運作。
- **iOS AudioWorklet 的音質**：以 48 kHz 預設 context 長時間播放、切換藍牙裝置、鎖屏 30 分鐘。對應 WebKit bug 226240 與 258864。
- **context suspended 時，送往 worklet 的 message 是否確實延後處理**（§2.2 的推論）。
- **各平台 `getOutputTimestamp().contextTime` 是否已經扣掉裝置延遲**：Chromium 確定有扣，WebKit 與 Firefox 未查。藍牙耳機的回報值也要確認。
- **WebKit 的 noise injection policy 在哪些情境下啟用**，以及 `outputLatency` 固定為 512/sampleRate 對同步的影響。
- **MDN BCD 對 Chrome Android `linearRampToValueAtTime()` 的 partial 註記**是否仍然適用。
- **WebKit 串行執行 suspend 和 resume（`m_currentRenderingOperation`）從哪個 Safari 版本開始**。更早的版本可能不保證呼叫順序，所以 Engine 自己的佇列不能省。
- **背景時 Worker 的 timer 與 message 頻率**：iOS 與 Android Chrome 都沒有官方文件。
