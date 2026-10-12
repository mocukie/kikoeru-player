# libav.js 讀取中止與並行行為的實測

> Research ticket：[#17](https://github.com/mocukie/kikoeru-player/issues/17)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)）
> 實測日期：2026-10-12。對象：libav.js `v6.10.9.0`（FFmpeg 9.0）的自訂 variant `kikoeru-af`（[#10](https://github.com/mocukie/kikoeru-player/issues/10) 的設定），在 Engine 預定的用法下測：Engine 自己的 module Worker 內以 `noworker`（direct 模式）載入，block reader device 接 HTTP Range `fetch`。
> 標記說明：**[實測]** 本次在瀏覽器量到；**[原始碼]** 對照 FFmpeg／libav.js 原始碼；**[推論]** 由實測與原始碼推得；**[未測]** 本次無法測。

## 結論先講

1. **中止 read 之後，同一個 demuxer 可以恢復，不必重開，但要同時清兩個地方再 seek。** MKV、MP4、WAV、MP3 的表現完全一樣，Chromium、WebKit、Firefox 也一樣 [實測]：
   - libav.js 的 block reader device 會一直保留這次的錯誤，之後每個 read 都直接重丟同一個 `AbortError`。要先呼叫一次 `ff_block_reader_dev_send(name, 0, new Uint8Array(0))`，把錯誤清掉。
   - `pb->error`（值為 `-11`）不會自己清。只清 device 的話，seek 後讀 60 個封包都正確，可是**讀到檔尾時會丟出舊的 `AbortError`，而不是 EOF**（`demux.c` 把 EOF 換成 `pb->error`）。所以 `pb->error` 與 `eof_reached` 也要歸零。這需要對 libav.js wrapper 打一個 0BSD 小 patch，補上 `AVIOContext_error`／`eof_reached` 的 accessor（[`avio-accessors.patch`](../../research/libavjs-runtime-spike/avio-accessors.patch)，共 6 行）。
   - 只重設 `pb->error` 沒有用。中止之後**一定要 seek**，不能直接續讀：MKV 會直接回 EOF，WAV 與 MP3 會讀到錯位的封包。
   - 不想打 patch 的話，可以 close 再重開 demuxer。重開的成本：MP3 約 5 ms，MP4／MKV 約 17–41 ms，WAV 約 55–70 ms（本機 server，延遲 2 ms）。
   - 有兩個陷阱。第一，MKV 與 MP3 的 `av_seek_frame` 在 seek 過程中被中止時**仍然回傳 0**，所以 Engine 不能用回傳值判斷有沒有中止，要看自己的 abort 旗標。第二，開檔時被中止，錯誤會被換成泛用的 `Error: Could not open source file`，原本的 `AbortError` 不見了。
2. **read 掛起時，同一個 instance 的解碼不會被擋，結果也正確** [實測，三家瀏覽器]。Asyncify 暫停 demux read 的期間呼叫 `ff_decode_multi` 與 `ff_decode_filter_multi`（atempo → fltp），分別約 10 ms 與 26 ms 就完成，跟沒有掛起時一樣。輸出 hash 與參考結果相同，被暫停的 read 恢復後讀到的 201 個封包也與參考完全相同。**會被擋的是走 `serially()` 佇列的呼叫**，例如 `ff_read_frame_multi`、`av_seek_frame`、`ff_init_demuxer_file`：同一個 instance 開第二個檔，就等滿了 1.5 秒的掛起時間。結論是 **demux 與 decode 不需要拆成兩個 instance**，但 seek 一定要先中止掛起的 read。
3. **多個 instance 的成本**：每個 instance 的 wasm heap 都是 24 MiB（`INITIAL_MEMORY`），播放中沒有變大 [實測]。實際增加的 PSS 因引擎而異。Chromium 第一個 instance 約 +53 MiB，之後每個約 +11–23 MiB。WebKit 第一個約 +103 MiB，之後每個約 +29–95 MiB。CPU 方面，主檔（MKV 的 H.264 封包 demux，加上 AAC 解碼與 atempo）約 7–12 ms／媒體秒，外掛音軌（MP3 解碼加 atempo）約 17–19 ms／媒體秒。同一個 Worker 與分開的 Worker 量不出差別。
4. **記憶體回收**：close 加上放掉參照之後，**WebKit 完全沒有回收**（4 個 instance 時 635 → 630 MiB），要 `worker.terminate()` 才會降。開關 200 次的對照實驗顯示，**libav.js instance 的建立與丟棄本身不會累積**：只建立再丟掉 instance 200 次，Chromium 與 WebKit 在第 25 次之後都持平。重用 Worker 時 Chromium 看到的線性成長（約 0.4 MiB／次），在不碰 libav.js、只做相同 Range `fetch` 的對照組也會出現，所以來源是 Worker 內的 fetch，不是 libav.js [實測；可能是 Playwright 的 CDP 網路檢查保留了 response，[推論]]。重建 Worker 的成本：每次多約 35–40 ms（主執行緒預先編譯 `WebAssembly.Module` 再 postMessage 給 Worker），自己編譯則多約 75–90 ms。
5. **Asyncify 的速度代價**：與同一份物件檔、不開 Asyncify 的 link 相比，Engine 實際走的「解碼 + filter graph」路徑慢 13–25%，純解碼慢 5–69%（WAV 這類很輕的工作比例最高），demux 慢 0–42% [實測]。以絕對值看，300 秒的音訊做「解碼 + atempo」只需 1.3–2.5 秒，遠低於即時播放的需求。
6. **H.264 Annex B 不帶 `description`**：Chromium 153、Playwright WebKit 26.6（Linux／GStreamer）與 Firefox 155，在 Worker 與主執行緒都接受，跟 AVCC 加 avcC 的結果一樣 [實測]。**前提是每個 keyframe 都要帶 in-band SPS／PPS**。拿掉之後，Chromium 與 WebKit 回 `EncodingError`；**Firefox 不報錯，但也不輸出任何 frame**。Apple Safari（VideoToolbox）與 iOS **[未測]**。
7. **WebKit 上 VideoFrame transfer 回主執行緒再繪製**：以 30 fps 播 1080p 時，transfer 延遲 p95 ≤ 1 ms，`drawImage` 到 1280×720 的 2D canvas p50 3 ms、p95 4 ms，加上 1px readback（強迫繪製完成）約 3 ms [實測，Playwright WebKit headless，軟體繪製]。不限速時可以到 200 fps。Chromium 的 `drawImage` 約 7 ms，Firefox 約 9 ms。真機 Safari 的 GPU frame 路徑 **[未測]**。
8. **`WebAssembly.Module` 可以 postMessage 給 Worker**，三家都可以 [實測]。Worker 拿到後 instantiate 加上 libav.js 初始化與第一次開檔，WebKit 約 40 ms（自己編譯則約 77 ms），Firefox 約 35 ms（約 59 ms），Chromium 約 30 ms（約 40 ms）。

---

## 0. 環境與方法

- **variant**：用 [#10](https://github.com/mocukie/kikoeru-player/issues/10) 的 `research/build-spike`（branch `research/ffmpeg-wasm-build`）build `kikoeru-af`，另外多打了 `avio-accessors.patch`。另外以同一份 FFmpeg 物件檔、拿掉 `-s ASYNCIFY` 重新 link 出 `kikoeru-af-noasyncify`，只用來量速度。wasm 1947.5 KiB raw，與 #10 的數字相同。
- **瀏覽器**：官方 Docker image `mcr.microsoft.com/playwright:v1.63.0-noble` 裡的 Chromium 153.0.8010.12、WebKit 26.6（WPE，Linux）、Firefox 155.0。全部是 headless、沒有 GPU。機器是 AMD EPYC 7K62，32 vCPU。
- **harness**（`research/libavjs-runtime-spike/`）：
  - Node 靜態 server：支援 HTTP Range，可用 `?lat=` 加上延遲，`.wasm` 回 `application/wasm`，`no-store`。
  - 頁面：每個測試開一個 module Worker。libav.js 以 `noworker` 載入，並透過 `factory` 選項的 `instantiateWasm` 共用預先編譯的 `WebAssembly.Module`。
  - block reader：每次 cache miss 發一個 Range 請求，每個請求一個 `AbortController`。
  - 記憶體：由 runner 從 `/proc` 加總所有瀏覽器 process 的 **PSS**。
- **媒體**（`gen-media.sh`，ffmpeg 7.1）：
  - abort／pending 測試：60 秒、內容為正弦波加雜訊的 `ab.mkv`／`ab.mp4`（H.264 640×360 加 AAC，約 12 MB，moov 在檔尾）、`ab.wav`（s16）、`ab.mp3`（192k）。
  - 速度測試：300 秒的 mp3、m4a、flac、opus、wav（s24）。
  - 外掛音軌：120 秒的 `ext.mp3`。
  - WebCodecs：H.264 high profile 的 Annex B 原始串流，720p 與 1080p，30 fps，GOP 30，每個 access unit 前有 AUD，每個 IDR 前都有 SPS／PPS。
- **比對方式**：封包以「stream、pts、大小、FNV-1a hash」比對；解碼結果以所有 plane 的 hash 比對。參考結果一律來自另一個沒有中止、沒有掛起的 instance，做同樣的步驟。

## 1. read 中止後的恢復（abort → seek）

做法：每個情境都用一個新的 instance。開檔後先讀 40 個封包，再讓下一個 cache miss 的 fetch 掛起（server 延遲 10 分鐘），30 ms 後 `AbortController.abort()`。接著依「恢復方式」處理，然後 `av_seek_frame` 到 30 秒，讀 60 個封包與參考比對；最後 seek 到檔尾前 2 秒，讀到結束。

**中止本身** [實測]：

- **read 中被中止**：`ff_read_frame_multi` 在 abort 後 1 ms 內 reject，丟出的就是 `fetch` 的那個 `AbortError`（各引擎的訊息不同，`name` 都是 `AbortError`）。這時 `pb->error = -11`、`eof_reached = 1`。
- **seek 中被中止**：
  - MKV、MP3 的 seek 會讀網路，被中止時 `av_seek_frame` **仍回傳 0**。這時 `pb->error = -11`、`eof_reached = 0`。
  - MP4、WAV 的 seek 只靠 index 或計算，不讀網路，所以中止落在 seek 之後的第一個 read。
- **開檔中被中止**（第 1 個 read）：`ff_init_demuxer_file` reject，訊息是 `Error: Could not open source file`，**原本的 `AbortError` 不見了**。

**恢復方式的比較**（四種容器、三個瀏覽器，「read 中」與「seek 中」被中止的結果完全相同）[實測]：

| 恢復方式 | seek 後的 60 個封包 | 讀到檔尾 | 說明 |
|---|---|---|---|
| 什麼都不做 | 0/60，重丟舊的 `AbortError` | — | block device 保留錯誤（`p-avformat.in.js` 的 `data.error`，要等下一次 `ff_block_reader_dev_send` 才清） |
| 只重設 `pb->error`／`eof_reached` | 0/60，重丟舊的 `AbortError` | — | device 的錯誤還在 |
| 只清 device（送一次空資料） | **60/60** | **丟出舊的 `AbortError`，不是 EOF** | `pb->error` 還是 -11。`demux.c` L1582 會把 `AVERROR_EOF` 換成 `pb->error`，libav.js 再把 -11 當成「轉送錯誤」重丟 `fsThrownError` |
| **清 device ＋ 重設 `pb->error`／`eof_reached`** | **60/60** | **EOF** | 建議做法，需要 accessor patch |
| close 後重開 demuxer（同一個 instance） | 60/60 | EOF | 不需要 patch。重開耗時：MP3 4.5–6 ms、MP4 17–24 ms、MKV 20–41 ms、WAV 53–71 ms（本機 server，延遲 2 ms） |
| 清 device ＋ 重設，**不 seek** 直接續讀 | MKV：立刻 EOF（0 個封包）；MP4：接在參考第 67 個之後（中止的那次 read 已經讀走的封包遺失）；WAV、MP3：讀到錯位的封包 | — | 中止之後一定要 seek |
| 同上，但是在 seek 中被中止 | MKV：從頭開始；MP3：從參考第 112 個封包開始；MP4、WAV：錯位 | — | 被中止的 seek 會留下不確定的位置，一定要重新 seek |

**開檔中被中止**：清掉 device 之後，同一個 instance 可以直接再呼叫 `ff_init_demuxer_file`，後續的 seek 與讀取都正確（四種容器都是 60/60）[實測]。`avformat_open_input` 失敗時會自己釋放 context（`avformat.h` 的文件），所以 instance 不必丟掉。中止若發生在 `avformat_find_stream_info` 階段，libav.js 是否會 close 那個 context 沒有查證，最多漏一個 context，丟掉 instance 時一併回收 [推論]。

**為什麼只清 device 不夠** [原始碼，FFmpeg 9.0]：

- `aviobuf.c` 的 `avio_read` 只有在「一個 byte 都沒讀到」時才回傳 `s->error`（L672–675）。所以讀得到資料時，殘留的 `pb->error` 不會被察覺。
- 讀到檔尾時，`demux.c` 的 `av_read_frame` 會因為「demuxer 回 EOF，但 `pb->error < 0`」而改回傳 `pb->error`（L1580–1583）。
- matroskadec 有好幾個地方直接檢查 `pb->error`（L903、L960、L1545）。
- `avio_seek` 只清 `eof_reached`（L313、L331），不清 `error`。

**需要的 patch**（[`avio-accessors.patch`](../../research/libavjs-runtime-spike/avio-accessors.patch)，只改 libav.js 的 0BSD wrapper，不改 FFmpeg）：在 `src/b-avformat.c` 加上 `A(AVIOContext, int, eof_reached)`、`A(AVIOContext, int, error)`，並在 `funcs.json` 的 accessors 加一組 `["AVIOContext", ["eof_reached", "error"]]`。這樣就會產生 `AVIOContext_error`／`_error_s`、`AVIOContext_eof_reached`／`_eof_reached_s`，搭配既有的 `AVFormatContext_pb` 使用。可以跟 #10 的 disposition／start_time patch 合成一份，並一起 upstream。

## 2. read 掛起時，同一個 instance 的其他呼叫

做法：在同一個 instance 上先讀 300 個 AAC 封包並建好 decoder 與 filter graph（`atempo=1.25` → fltp），然後讓下一個 read 掛起 1.5 秒（之後的請求恢復正常延遲）。在 Asyncify 暫停期間呼叫：

| 呼叫 | 結果（MP4、MKV；Chromium、WebKit、Firefox 都一樣）[實測] |
|---|---|
| `ff_decode_multi`（150 個封包） | 10–16 ms 完成（參考值 15–18 ms），frame hash 與參考相同 |
| `ff_decode_filter_multi`（150 個封包，atempo → fltp） | 25–32 ms 完成（參考值 31–37 ms），hash 與參考相同 |
| `av_packet_alloc`／`av_packet_free_js` | 正常 |
| 同一個 instance 的 `ff_init_demuxer_file`（第二個檔，本身不延遲） | **等到掛起的 read 結束才完成**（1480–1487 ms） |
| 掛起的 `ff_read_frame_multi` 恢復後 | 201 個封包與參考完全相同 |
| 另一個 instance 的 `ff_decode_multi` | 不受影響（9–17 ms，hash 相同） |

解讀：

- direct 模式下，`ff_decode_multi`、`ff_decode_filter_multi` 只呼叫同步的 export（`avcodec_send_packet`、`av_buffersrc_add_frame` 等），不經過 libav.js 的 `serially()` 佇列 [原始碼：`tools/mk-post.js` 只把 `async: true` 的函式包進 `serially()`；`p-avcodec.in.js`]。
- Emscripten 在 unwind 完成後，`Asyncify.state` 會回到 Normal，所以這些同步呼叫可以在暫停期間執行，而且實測不會破壞被暫停的呼叫堆疊 [實測]。前提是這些同步呼叫內部不能再碰到 async import；解碼與 filter 不做 I/O，所以成立 [推論]。
- **會被擋的是 demux 側的 async 呼叫**：read、seek、open。這正是 seek 一定要先中止掛起 read 的原因，否則 seek 會排在一個可能要等很久的網路請求後面。
- worker 模式（libav.js 自己開 Worker）的 RPC 是逐一處理，結論可能不同；Engine 不採用這個模式，所以沒有測。

## 3. 多個 instance（主檔＋外掛音軌）的記憶體與 CPU

做法：在同一個 Worker 依序加入 instance，每個 instance 是一個完整的「來源」（block reader、demuxer、音訊 decoder 與 `atempo=1.0` → fltp filter graph）。每一步讓所有 instance 從頭各播 30 秒，以每 1 秒輪流的方式前進，然後量 PSS。CPU 時間已經扣掉等 fetch 的時間 [實測]。

PSS（MiB，所有瀏覽器 process 合計；括號內是與上一步的差）：

| 步驟 | Chromium | WebKit | Firefox |
|---|---|---|---|
| 頁面 baseline | 171.8 | 311.2 | 456.6 |
| 開一個空的 Worker | 174.9（+3） | 314.6（+3） | 458.7（+2） |
| + 主檔 `ab.mkv` | 227.8（+53） | 417.2（+103） | 519.8（+61） |
| + 外掛音軌 `ext.mp3`（同一個 Worker） | 239.2（+11） | 445.7（+29） | 498.6（GC 雜訊） |
| 共 4 個 instance（同一個 Worker） | 284.1（+45） | 635.1（+189） | 627.7（+129） |
| close 全部並放掉參照（Worker 還在） | 259.0（−25，已強制 `gc()`） | **629.9（−5）** | 487.5（−140） |
| `terminate()` Worker | 208.3 | 398.5 | 469.6 |
| 對照：主檔與外掛音軌各一個 Worker | 261.8 | 553.4 | 570.1 |

- 每個 instance 的 wasm heap 都是 24.0 MiB，播 30 秒都沒有變大 [實測]。Chromium 只把碰過的 page 算進 PSS，所以每個 instance 的實際成本最低；WebKit 每個 instance 的成本最高 [實測]。
- **WebKit 在放掉參照之後沒有回收**，至少在這個測試的 1.5 秒觀察窗內沒有；`terminate()` 才會回收 [實測]。Chromium 即使強制 `gc()` 也只收回一小部分 [實測]。
- 「每個來源一個 Worker」與「同一個 Worker 兩個 instance」的 CPU 量不出差別（各 instance 的 ms／媒體秒都在 ±10% 內）。記憶體方面，兩個 Worker 在 Chromium 多約 20 MiB，在 WebKit 多約 100 MiB [實測]。

CPU（ms／媒體秒；4 個 instance 時同時存在的 instance 不影響各自的數字）[實測]：

| 來源 | demux | 解碼 ＋ atempo ＋ 轉 fltp |
|---|---|---|
| 主檔 `ab.mkv`（H.264 1.5 Mbps 封包只 demux 不解碼、AAC 128k） | 0.8（Chromium）／0.9–1.2（WebKit）／3.4–3.8（Firefox） | 6.5–8 |
| 外掛音軌 `ext.mp3`（192k） | 0.6–0.8／0.7–1.0／3.6–4.0 | 16.4–19.5 |

主檔加上外掛音軌，大約佔單核 2.5–3%（這台 EPYC）。行動裝置可以粗估慢 3–5 倍，仍然在 15% 以內 [推論]。

## 4. 上百次開關：重用 Worker 與重建 Worker

做法：每個「cycle」都是「建立 instance → 開 `ab.mp3` → 解碼加 atempo 約 2 秒 → close 全部 → 放掉 instance」。重用模式是在同一個 Worker 內連續做；重建模式是每次開一個新的 Worker，做一次就 `terminate()`。每 25 次量一次 PSS [實測]。

| 模式（200 次） | 每次耗時 | Chromium PSS（baseline → 200 次 → 結束） | WebKit PSS | Firefox PSS |
|---|---|---|---|---|
| 重用 Worker（full） | 27 ms（Chromium）／29–31 ms（WebKit）／42 ms（Firefox） | 171 → 294 → terminate 後 212（線性約 0.4 MiB／次） | 309 → 453 → 418（前 25 次 +80，之後約 0.3 MiB／次） | 504 → 564（GC 造成 ±50 的起伏） |
| 重建 Worker，主執行緒 postMessage `WebAssembly.Module` | 62／71／82 ms | 172 → 226 → 209（約 0.13 MiB／次，結束後部分回收） | 310 → 422（100 次之後持平） | 553 → 573（起伏） |
| 重建 Worker，Worker 自己編譯（100 次） | 105／122／111 ms | 174 → 205 | 310 → 435（持平） | 532 → 615 → 525 |

對照實驗（都是重用 Worker、200 次），用來分辨成長的來源 [實測]：

| 對照 | Chromium | WebKit | Firefox |
|---|---|---|---|
| 只建立再丟掉 instance（不開檔） | 169 → 204（第 25 次）→ 218，**持平** | 315 → 360 → 364，**持平** | 421 → 406，持平 |
| 同一個 instance 重複「開檔 → 解碼 → close」（heap 一直是 24 MiB） | 172 → 278（線性） | 311 → 425（第 25 次）→ 446，持平 | 417 → 579（起伏） |
| **不碰 libav.js，只做相同的 3 個 Range `fetch`** | 169 → **319（線性約 0.75 MiB／次）**，terminate 後回到 179 | 316 → 397 → 401，持平 | — |

解讀：

- libav.js instance 的建立與丟棄本身不會累積記憶體，GC 會收回（只建立再丟掉的對照組持平）[實測]。
- 重用 Worker 時，Chromium 的線性成長在「只 fetch」的對照組更明顯，所以來源是 Worker 內 fetch 的 response，不是 libav.js [實測]。這很可能是 Playwright 透過 CDP 開了 Network domain、保留 response body 造成的，正式環境不一定會發生 [推論，未進一步驗證]。不論原因，`terminate()` 都會把它清掉。
- 重用 Worker 每次省下約 35–40 ms（Module 先由主執行緒編譯好）或 75–90 ms（Worker 自己編譯）。切換檔案時的 load 本來就要等網路，這個差距人感覺不到 [推論]。
- WebKit 在兩種模式下都有約 +80～+110 MiB 的「第一次之後的水位」，之後持平；重用模式在 200 次後仍緩慢上升（約 0.3 MiB／次），`terminate()` 後降回 +108 [實測]。

## 5. Asyncify 的速度代價

做法：同一份 FFmpeg 物件檔，`kikoeru-af`（Asyncify）與 `kikoeru-af-noasyncify`（只拿掉 `-s ASYNCIFY`、`ASYNCIFY_IMPORTS`）各跑一次。檔案整個放進 MEMFS（沒有 Asyncify 就不能用 block reader），每個量 3 次取中位數。noasyncify 的 glue 要把 `ccall` 的 `{async:true}` 包成 Promise，libav.js 的 post code 才能運作（見 `build.sh`）[實測]。

300 秒音訊，單位 ms，格式為「Asyncify／無 Asyncify（差距）」：

| 檔案 | 引擎 | 開檔＋讀完所有封包 | 純解碼 | 解碼 ＋ atempo 1.25 ＋ fltp |
|---|---|---|---|---|
| mp3 192k | Chromium | 77／56（+38%） | 776／724（+7%） | 1938／1717（+13%） |
| | WebKit | 80／60（+33%） | 819／705（+16%） | 2077／1744（+19%） |
| | Firefox | 400／359（+11%） | 815／755（+8%） | 2209／1892（+17%） |
| aac（m4a）192k | Chromium | 72／59（+22%） | 623／502（+24%） | 1797／1480（+21%） |
| | WebKit | 82／61（+34%） | 624／445（+40%） | 1899／1523（+25%） |
| | Firefox | 443／405（+9%） | 650／558（+16%） | 2075／1715（+21%） |
| flac | Chromium | 121／102（+19%） | 375／355（+6%） | 1530／1331（+15%） |
| | WebKit | 130／96（+35%） | 353／334（+6%） | 1539／1339（+15%） |
| | Firefox | 222／220（+1%） | 414／361（+15%） | 1726／1517（+14%） |
| opus（ogg）128k | Chromium | 73／60（+22%） | 1017／919（+11%） | 2171／1870（+16%） |
| | WebKit | 68／59（+15%） | 1043／990（+5%） | 2282／2009（+14%） |
| | Firefox | 465／432（+8%） | 1093／994（+10%） | 2488／2115（+18%） |
| wav s24 | Chromium | 69／57（+21%） | 126／114（+11%） | 1265／1080（+17%） |
| | WebKit | 44／31（+42%） | 118／70（+69%） | 1290／1094（+18%） |
| | Firefox | 161／168（−4%） | 151／105（+44%） | 1463／1247（+17%） |

- Engine 實際走的「解碼 ＋ filter graph」路徑，Asyncify 讓它慢 13–25%。以絕對值看，300 秒音訊在 1.3–2.5 秒內處理完，是即時速度的 120–230 倍 [實測]。
- 時間大多花在 atempo 與轉換（解碼加 filter 是純解碼的 2–10 倍）。Asyncify 的比例代價在 filter 裡同樣存在 [實測]。
- 體積代價見 #10（brotli 後 +95 KiB）。這兩個數字都不構成換掉 Asyncify 的理由，JSPI 照 #4 的結論維持為之後的升級 [推論]。
- `ASYNCIFY_REMOVE` 排除 libavcodec／libavfilter 這類縮小 instrument 範圍的做法沒有試，留給實作時的最佳化 [未測]。

## 6. H.264 Annex B 不帶 `description`

做法：同一條 Annex B 串流用兩種方式送進 `VideoDecoder`。一種是不帶 `description`、chunk 為 Annex B；另一種是自行轉成 AVCC（4 byte 長度前綴）並帶 avcC `description`。在 Worker 與主執行緒各跑一次，720p 與 1080p 都測 [實測]：

| 情境 | Chromium 153 | WebKit 26.6（WPE／GStreamer） | Firefox 155 |
|---|---|---|---|
| Annex B，不帶 description，從頭解 | 300/300 | 300/300 | 300/300 |
| AVCC ＋ avcC description，從頭解 | 300/300 | 300/300 | 300/300 |
| Annex B，從第二個 IDR 開始（keyframe 帶 SPS／PPS） | 270/270 | 270/270 | 270/270 |
| Annex B，從第二個 IDR 開始，**拿掉 in-band SPS／PPS** | `EncodingError`，decoder closed | `EncodingError`，decoder closed | **不報錯、0 個 frame、decoder 仍是 configured** |
| `isConfigSupported`（以上全部） | true | true | true |

- Worker 與主執行緒的結果一樣。1080p 解 300 個 frame 的時間：Chromium 約 450 ms，WebKit 約 1210 ms，Firefox 約 365 ms（headless 軟體解碼）。
- 對 Engine 的意義：
  - MP4／MKV 的 H.264 幾乎都是 avcC，直接當 description 用即可。
  - 只有 extradata 是 Annex B（`00 00 00 01` 開頭）或沒有 extradata 時，才走「不帶 description」。這時要確認每個 keyframe 都帶 SPS／PPS；如果 extradata 裡有 SPS／PPS 但封包裡沒有，就要在 seek 後的第一個 keyframe 前補上。
  - Firefox 遇到參數集缺漏不會報錯，所以「configure 後第一個 keyframe 沒有輸出」也要歸到同一個解碼錯誤碼，跟 #5 的建議相同。
- **[未測]**：Apple Safari（macOS，VideoToolbox）與 iOS Safari。Playwright 的 WebKit 在 Linux 上用的是 GStreamer 解碼後端，與 Apple 平台的實作不同，所以這裡的結果不能代表 Safari。規格（W3C AVC registration）寫明沒有 description 時視為 Annex B，但 Safari 是否照做，要在實機上確認。

## 7. VideoFrame transfer 回主執行緒再繪製（以 WebKit 為主）

做法：
- Worker 內以 `VideoDecoder` 解 1080p H.264，每個輸出 frame 都 `postMessage(frame, [frame])` 給主執行緒。
- 主執行緒 `drawImage` 到 1280×720 的 2D canvas，然後 `close()`；每 10 張做一次 1px `getImageData`，強迫繪製完成。
- 跑兩種模式：(a) 以 30 fps 送入 decoder，模擬播放；(b) 不限速，主執行緒 ack 控制同時在途的 frame 不超過 4 張。
- 另外加一組由 CPU buffer 建立的 I420 frame（模擬 wasm 軟解的輸出）[實測]。

| 引擎 | 模式 | transfer 延遲 p50／p95（ms） | `drawImage` p50／p95（ms） | 1px readback p50／p95（ms） | 達成 fps |
|---|---|---|---|---|---|
| WebKit | 30 fps 解碼 | 0／1 | 3／4 | 3／4 | 30.2 |
| WebKit | 不限速解碼 | 14／25（含排隊） | 3／5 | 5／10 | 200 |
| WebKit | 不限速 CPU I420 | 15／22（含排隊） | 3／5 | 5／7 | 200 |
| Chromium | 30 fps 解碼 | 0.1／0.2 | 7.2／7.8 | 0／0.2 | 30.3 |
| Chromium | 不限速解碼 | 21.7／23.5（含排隊） | 6.8／7.4 | 0／0.1 | 143 |
| Firefox | 30 fps 解碼 | 約 0（跨執行緒時鐘誤差）／0 | 9／10 | 0／0 | 30.1 |
| Firefox | 不限速解碼 | 30／32（含排隊） | 10／11 | 0／0 | 102 |

- WebKit 的計時器解析度是 1 ms，所以 p50 為 0 代表小於 1 ms。不限速模式的延遲大多是在佇列裡等待（最多 4 張在途），不是 transfer 本身。
- 解碼器輸出的 frame 格式：Chromium／WebKit 是 `I420`，Firefox 是 `BGRX`，都是 CPU 記憶體上的 frame（headless 沒有 GPU）。
- 結論：在這個環境下，「Worker 解碼 → transfer → 主執行緒畫」的成本主要在 `drawImage`（每張 3–10 ms，軟體繪製）；transfer 本身可以忽略。30 fps 時每張預算 33 ms，餘裕很大 [實測]。
- **[未測]**：Apple Safari／iOS 的 VideoToolbox 輸出 frame（IOSurface 與 GPU 路徑），以及有 GPU 的 Chromium。GPU 路徑通常更便宜，但也可能多出 GPU → CPU 的複製；需要在 Demo 頁上用實機量 [推論]。

## 8. `WebAssembly.Module` 能否 postMessage 給 Worker

- 三家都可以 [實測]。主執行緒用 `WebAssembly.compileStreaming` 編譯，用 `postMessage` 傳給 module Worker，Worker 再經 libav.js 的 `factory` 選項，以 Emscripten 的 `instantiateWasm(imports, cb)` hook 建立 instance。用 `MessageChannel` 做 structured clone 也可以。
- 時間（5 次中位數附近，ms）：

| | Chromium | WebKit | Firefox |
|---|---|---|---|
| 主執行緒 `compileStreaming`（1.9 MiB wasm） | 10 | 36 | 24 |
| Worker：收到 Module → instantiate ＋ libav.js 初始化 ＋ 第一次開檔 | 30 | 40 | 35 |
| Worker：自己 `compileStreaming` → 同上 | 40 | 77 | 59 |

- libav.js 的 direct 模式沒有直接接受 `WebAssembly.Module` 的選項，要用自己的 `factory` 包一層，在呼叫 glue 時加上 `instantiateWasm`（`research/libavjs-runtime-spike/lib.mjs` 的 `createLibAV`）。glue 的 `instantiateWasm` callback 只收 `instance` 一個參數 [實測，emsdk 6.0.5 的輸出]。
- iOS Safari 的 WebKit 與這裡的 WPE WebKit 共用 structured clone 的實作，應該一樣可行 [推論]；實機 [未測]。

## 9. 沒有測到的項目

- **iOS 實機與 macOS Safari**：本機只有 Linux 上的 Playwright WebKit（WPE、GStreamer、軟體繪製）。H.264 Annex B、VideoFrame 的 GPU 路徑、記憶體壓力（iOS 每個 tab 的上限）、iOS 上 Asyncify 的效能，都要等 Demo 頁上線後用實機補測。
- **有 GPU 的瀏覽器**：所有繪製數字都是軟體繪製。
- **正式網路環境下的 fetch 記憶體**：§4 的 fetch 成長可能是 Playwright 的 CDP 造成的，沒有在非自動化的瀏覽器量。
- **`ASYNCIFY_REMOVE`／`ASYNCIFY_ADVISE`**：縮小 instrument 範圍的最佳化。
- **libav.js worker 模式**：Engine 不採用，沒有測。

## 10. 對執行緒架構決策的含意

1. **instance 的數量：每個來源一個 libav.js instance，demux 與 decode 共用。**
   - 解碼呼叫在 read 掛起時不會被擋，結果也正確（§2），不需要為了「網路卡住時還能解碼」把 decode 拆成另一個 instance。這省下每個來源 24 MiB 的 heap，以及 WebKit 上 30–100 MiB 的 PSS。
   - 主檔與外掛音軌仍然要各用一個 instance，因為它們的 read、seek 會互相排隊（§2 的第二個 `ff_init_demuxer_file` 等滿了 1.5 秒）。
   - Engine 的 Worker 內，所有 async 的 libav.js 呼叫（open、read、seek、close）要經過 per-instance 的指令佇列。解碼則直接同步呼叫，不排進這個佇列。

2. **Worker 的配置：每個 Engine 一個 media Worker，所有來源的 instance 都放在裡面（維持 #8 的候選 A）。**
   - 分開 Worker 量不出 CPU 好處，記憶體反而多 20–100 MiB（§3）。
   - 切換檔案（load）時，**在同一個 Worker 內丟掉舊 instance、建立新 instance** 即可。instance 的建立與丟棄本身不會累積記憶體（§4 對照組）。
   - **`destroy()` 時 `terminate()` Worker。** WebKit 不會及時回收放掉參照的 instance，只有 terminate 保證歸還（§3）。
   - 可以考慮設一個保險絲：連續切換 N 個檔案（例如 50 個）後，在下一次 load 時重建 Worker。代價是每次多約 35–40 ms（Module 由主執行緒預先編譯並 postMessage）[推論]。
   - **主執行緒持有編譯好的 `WebAssembly.Module`**（三家都能 postMessage），重建 Worker 時直接傳過去，省掉每次 40–80 ms 的編譯。

3. **abort／seek 的恢復程序**（Engine 的 demux 端，按順序）：
   1. 新的 seek（或被取代的指令）進來時，先 `AbortController.abort()` 掛起中的 fetch。被中止的 libav.js 呼叫會在 1 ms 內 reject，丟出 `AbortError`。
   2. 等那個呼叫 reject 之後，才對同一個 instance 發下一個 async 呼叫（指令佇列保證這點）。
   3. `ff_block_reader_dev_send(name, 0, new Uint8Array(0))`：清掉 device 的錯誤。
   4. `AVIOContext_error_s(pb, 0)`、`AVIOContext_eof_reached_s(pb, 0)`：需要 accessor patch。
   5. 一定要 `av_seek_frame`／`avformat_seek_file`（不可以直接續讀），再 `avcodec_flush_buffers`，filter graph 重建或送 flush。
   6. 判斷中止要看 Engine 自己的 abort 旗標或 epoch，不能看回傳值：MKV／MP3 被中止的 seek 會回傳 0，開檔被中止時會丟出泛用的 `Error`。
   7. 開檔（`ff_init_demuxer_file`）中被中止：清掉 device，在同一個 instance 重新開檔即可，不必丟 instance。
   8. 不打 patch 的備案：第 4 步改成 close 再重開 demuxer（5–70 ms，probe 讀到的資料大多會命中 Engine 的 Range 快取）。
   - 上面的程序在 MKV、MP4、WAV、MP3 與三家瀏覽器都通過封包層級的比對；其他容器（FLAC、OGG、CAF、WavPack、ADTS AAC）沒有逐一測，建議在實作 issue 的測試裡涵蓋 [推論]。

4. **對 build 的要求**：
   - `avio-accessors.patch` 併進 #10 的 wrapper patch（libav.js 0BSD 部分），並一起 upstream。
   - 不需要第二個 variant。
   - Asyncify 維持不變，速度代價在播放上可以忽略（§5）。

5. **WebCodecs 端**：
   - H.264 Annex B 不帶 description 可以用，但要保證每個 keyframe 都有 in-band SPS／PPS。
   - Firefox 對缺少參數集不會報錯，所以「configure 後第一個 keyframe 沒有輸出」要有 timeout，並歸到解碼錯誤碼（§6）。
   - VideoFrame 一律 transfer 回主執行緒畫，在 WebKit 上的成本以 `drawImage` 為主（§7）；OffscreenCanvas 維持 App 選用。

## spike 的使用方式

位置：`research/libavjs-runtime-spike/`。build 產物、媒體與結果 JSON 都不進 git。

```sh
# 1. build（需要 research/ffmpeg-wasm-build branch 的 research/build-spike）
research/libavjs-runtime-spike/build.sh <build-spike 目錄> /tmp/rt/w
# 2. 媒體
research/libavjs-runtime-spike/gen-media.sh /tmp/rt/media
# 3. 在 Playwright 1.63.0 的 Docker image 內跑（先在該目錄 npm install）
research/libavjs-runtime-spike/run-docker.sh /tmp/rt/w/libav.js/dist /tmp/rt/media /tmp/rt/res/results.json \
  chromium,webkit,firefox 'abort;pending;pending:{"file":"ab.mkv"};speed;m-multi;m-cycles:{"mode":"reuse"};m-cycles:{"mode":"recreate-module"};h264;m-transfer;m-modpost'
node research/libavjs-runtime-spike/summarize.mjs /tmp/rt/res/results.json
```

| 檔案 | 內容 |
|---|---|
| `build.sh`、`avio-accessors.patch` | 在 #10 的 build 上多打 AVIOContext accessor，並另外 link 一份不開 Asyncify 的版本 |
| `gen-media.sh` | 產生測試媒體 |
| `server.mjs` | Range、延遲、`application/wasm` 的靜態 server |
| `run.mjs`、`run-docker.sh` | Playwright runner，從 `/proc` 加總 PSS |
| `lib.mjs` | `createLibAV`（共用 Module）、可中止的 block reader |
| `t-abort.mjs` | §1 |
| `t-pending.mjs` | §2 |
| `t-svc.mjs`、`svc.mjs`、`m-multi.mjs`、`m-cycles.mjs` | §3、§4 |
| `t-speed.mjs` | §5 |
| `h264.mjs`、`t-h264.mjs`、`m-h264.mjs` | §6 |
| `t-vframes.mjs`、`m-transfer.mjs` | §7 |
| `m-modpost.mjs` | §8 |

## 來源

- libav.js `v6.10.9.0`（commit `c80e885`）：`src/p-avformat.in.js`（block reader device 的 `data.error`、`ff_block_reader_dev_send`、`ff_read_frame_multi`、`ff_init_demuxer_file` 的 `serially`）、`src/post.in.js`（`serially`）、`tools/mk-post.js`（`returnsErrno` 的 -11 轉送、`async` 函式包進 `serially`）、`src/frontend.in.js`（direct 模式的 `factory({wasmurl, variant})`）、`src/b-avformat.c`、`funcs.json`、`Makefile.m4`（`EFLAGS`）— https://github.com/Yahweasel/libav.js/tree/v6.10.9.0
- FFmpeg 9.0：`libavformat/aviobuf.c`（`avio_read` L672–675、`avio_seek` L313／L331）、`libavformat/demux.c`（L1580–1583）、`libavformat/matroskadec.c`（L903、L960、L1545）— https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz
- Emscripten（emsdk 6.0.5 產生的 glue）：`instantiateWasm(info, receiveInstance)`、`cwrap`／`ccall` 的 `async` 選項
- W3C AVC (H.264) WebCodecs Registration（沒有 description 時視為 Annex B）— https://www.w3.org/TR/webcodecs-avc-codec-registration/
- 前置 research：[#3](https://github.com/mocukie/kikoeru-player/issues/3)（`docs/research/libavjs-evaluation.md`）、[#4](https://github.com/mocukie/kikoeru-player/issues/4)（`wasm-async-bridge.md`）、[#5](https://github.com/mocukie/kikoeru-player/issues/5)（`webcodecs-support.md`）、[#8](https://github.com/mocukie/kikoeru-player/issues/8)（`worker-architecture.md`）、[#10](https://github.com/mocukie/kikoeru-player/issues/10)（`ffmpeg-wasm-build.md`、`research/build-spike/`）
