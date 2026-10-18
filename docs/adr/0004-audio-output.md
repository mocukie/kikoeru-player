# 音訊輸出以 AudioWorklet 為唯一的時鐘，AudioContext 由 Engine 自己管理

音訊由 media Worker 經 `MessageChannel` 送進 AudioWorklet 的 ring buffer（ADR-0002），worklet 也是 Engine 唯一的**音訊時鐘**：時鐘只在實際播出 media sample 時前進，ring buffer 空了就停住，影片跟著等。沒有音軌、音訊比媒體短，或關閉音軌時，worklet 繼續輸出靜音並推進時鐘，直到 `duration`；`ended` 也由 worklet 判定。功能清單原本的「沒有音訊時改用 `performance.now()`」因此拿掉。

`AudioContext` 整個 Engine 只建立一個，**不指定 `sampleRate`**，`latencyHint: 'playback'`，一律輸出 stereo。Worker 的 filter graph 把每個來源重採樣成 `ctx.sampleRate`，並以 swresample 的預設係數 downmix。

## Considered Options

- **有音訊時用 audio clock，沒有時用 `performance.now()`**：切換音軌、音訊提前結束、關閉音軌時，都要在兩個時鐘之間交接，`ended` 也有兩種判定。只用一個時鐘的代價是純影片的媒體也需要 `AudioContext` 與 user gesture；kikoeru 的播放都由使用者觸發，這個代價幾乎不存在。
- **依來源開 44.1k／96k／192k 的 `AudioContext`**：換檔就要重建 context，也就要再一次 user gesture。瀏覽器不會因此改變硬體取樣率（iOS 的 WebKit 只會多一層重採樣），WebKit 還有非原生取樣率的 bug（274507、219201）。瀏覽器一律經 OS mixer 的 shared mode 輸出，網頁做不到 bit-perfect 或獨佔模式，所以 Engine 能控制的只有重採樣的品質。
- **暫停與 buffering 時 `ctx.suspend()`**：WebKit 的 `state` 會落後於呼叫（spike patch 0003 的 bug），iOS 中斷時 `resume()` 的 promise 可能永遠不 resolve。改由 worklet 淡出後輸出靜音，context 保持 running；只有暫停超過 30 秒，才經內部佇列 `suspend()` 以省電。這樣中斷結束後 WebKit 自己把 context resume 回來時，Engine 仍然是 paused，不必再 suspend 回去。
- **改速度時 flush ring buffer，從實際播放位置重新 stretch**：要在 Worker 保留一段已解碼的 PCM，並多一條 flush 路徑。改採 drain：以 `avfilter_graph_send_command` 改 `atempo` 的 tempo，ring 內舊速度的資料照常播完，大約 0.2 秒後生效；改速度不遞增 epoch。
  - 實作時（#43）改為在接點把舊的 `atempo` 送 EOF 排空、換一個新的，與進出 bypass 走同一條路，同樣接約 5 ms 的 crossfade：`send_command` 之後 `atempo` 內部從哪個 WSOLA fragment 開始用新的 tempo，從外面看不到，time map 的接點會有最多約一個 window（2048 sample）乘上速度比的誤差，而且一直留到下一次 seek。排空再換新的，接點的媒體時間就是送進新 `atempo` 的第一個輸入 sample，精確；`atempo` 排空時最後一段與新開始時第一段都是原樣的輸入，接點沒有跳點。drain 的語意不變：ring 內與已經 stretch 的舊速度資料照常播完。
- **一律經過 `atempo`**：`atempo` 在 1.0 沒有 passthrough，仍然會跑一遍 WSOLA，輸出不是原音，每秒都要付 FFT 的 CPU。1.0x 時繞過 `atempo`，進出時把它排空，再接上約 5 ms 的 crossfade。

## Consequences

- 「現在聽到的位置」以 `getOutputTimestamp()` 換算為主，取不到時依序用 `currentTime − outputLatency`、`currentTime − baseLatency`。WebKit 與 Firefox 的 `contextTime` 是否已經扣掉裝置延遲，要靠實機驗證；如果沒有扣，就在該瀏覽器上自己扣。v1 不提供裝置層級的延遲補償。
- underrun 時 worklet 淡出，進入 starved，等 ring 補回目標水位才淡入。starved 超過約 250 ms 才進入 `buffering`；更短的只計入 `getStats().audio.underruns`。
- media Worker 維護 time map：輸出依速度分段，PCM chunk 帶第一個 frame 的媒體時間與速度（不跨段），worklet 以它推進時鐘並在速度改變的那個 frame 送出 clock，`currentTime` 以 clock 的速度內插。沒有 PCM（`eof` 之後的靜音）時，worklet 以主執行緒告訴它的速度推進。`atempo` 的輸出以 window 為單位疊接，聲音相對 time map 有最多約一個 window 的偏移（靜音之後的起點尤其明顯），E2E 的容差另外訂定。
- ring buffer 的水位是 `EngineOptions.audioBuffer`，依 iOS／Android／桌面各有預設值；淡入淡出的長度是 `EngineOptions.audioFadeMs`。1.0x bypass 的 crossfade 不能設定。
- `suspend()`、`resume()`、`close()` 一律經 Engine 自己的串行佇列，不看 `state`，每個呼叫有 2 秒的 timeout。
- context 停住時的 watchdog：Engine 處於 `playing`，worklet 回報的 frame 卻超過 1 秒沒有前進時，依序執行：
  1. 先 `suspend()` 再 `resume()`。
  2. 重建 `AudioContext`：重新 `addModule`，給 Worker 新的 `MessageChannel`，並遞增 epoch。新的 context 因為沒有 user gesture 而沒有啟動時，送出非致命的 `AUDIO_LOCKED`。
  3. 仍然失敗就是 fatal 的 `AUDIO_OUTPUT`。
- 會遞增 epoch 的指令只有 seek、選軌、外掛音軌與 offset，改速度不遞增（修正「執行緒分工與 wasm 銜接方式」的 resolution）。
- 多聲道輸出與輸出裝置選擇（`setSinkId`，只有 Chromium 支援）都留待之後。接縫在 Engine 持有的 `AudioContext` 與 filter graph 的 downmix，不影響本 ADR 的其他決定。
