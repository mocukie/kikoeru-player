# libav.js 評估：不寫自己的 shim 能否做到 demux + decode

> Research ticket：[#3](https://github.com/mocukie/kikoeru-player/issues/3)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)）
> 調查日期：2026-10-12。對象：libav.js `master`（npm 最新 `6.10.9`，即 libav.js 6.10 + FFmpeg 9.0）。
> 標記說明：**[已查證]** 直接對照原始碼或官方文件；**[推論]** 由原始碼推得、未實測；**[未驗證]** 需要 prototype 實測。

## 結論先講

**可以，大致不需要自己寫 FFmpeg 的 C／JS glue。** libav.js 已經提供 Engine 需要的主要部件：自訂 variant 的 build 系統、非同步的 block reader device（可接 HTTP Range、可把錯誤傳進讀取中的呼叫）、Asyncify 銜接（不需要 COOP/COEP）、demux／seek／discard／decode 的 API、`codecpar`／extradata 取得，以及 Worker 執行模式。

但有幾個缺口，需要補一點東西，不過都不必寫一層自己的 shim：

1. **`AVStream.disposition`（default／forced）和每條軌的 `start_time` 沒有 accessor。** 最小補法是在 build 時對 libav.js 的 wrapper（`src/b-avformat.c` 與 `funcs.json`，0BSD）打兩行 patch，最好順便 upstream。這是 libav.js 的 wrapper，不是 FFmpeg 本身。
2. **中止讀取後，`AVIOContext.error` 不會自己清掉。** 中止之後，這個 demuxer 要視為已經壞掉，必須重新開檔。另一種做法是 seek 時不中止，讓進行中的那一塊讀完。`destroy()` 則直接丟掉整個 instance。
3. **同一個 instance 裡，所有 async 呼叫都會排隊。** 只要有一個讀取卡住，同一個 instance 的其他 async 呼叫都會跟著卡住。外掛音軌要用另一個 instance；decode 要不要再拆成獨立的 instance，要等 prototype 驗證。
4. **npm 上沒有適合的現成 variant**（AAC、MP3、ALAC、wavpack 等都不在發佈的 build 裡）。**一定要自己 build 自訂 variant**。好在不用 fork：checkout 固定的 tag，執行 `mkconfig.js` 和 `make build-<variant>` 即可。

---

## 1. 自訂 variant：build 方式、可選元件與體積

**build 方式 [已查證]**
- variant 由「configuration fragment」組成：`cd configs && ./mkconfig.js <name> '[...fragments]'`，再執行 `make build-<name>`（`docs/CONFIG.md`）。fragment 的命名直接對應 FFmpeg 的 configure 旗標：`demuxer-*`、`decoder-*`、`parser-*`、`bsf-*`、`format-*`、`codec-*`。大部分 fragment 不需要實體目錄，只要 FFmpeg 有對應的 `--enable-xxx` 就能用（`docs/CONFIG.md`「Implementation details」）。
- FFmpeg 的 configure 以 `--disable-everything --disable-swscale --disable-swresample` 為基底，只打開 fragment 列出的元件（`mk/ffmpeg.mk`）。repo 裡沒有任何 fragment 會打開 `--enable-gpl`、`--enable-version3` 或 `--enable-nonfree`（grep `configs/` 與 `mk/` 都找不到），所以預設是 LGPL。
- 編譯旗標（`Makefile.m4`）：`-Oz`、`-s ASYNCIFY`、`ASYNCIFY_IMPORTS=['libavjs_wait_reader', …jsfetch…]`、`INITIAL_MEMORY=24MiB`、`ALLOW_MEMORY_GROWTH=1`、`STACK_SIZE=1MiB`、`WASM_BIGINT=0`。
- 官方提供的 `Dockerfile.development` 標明「NOT MAINTAINED BY THE AUTHOR」，只有 `FROM emscripten/emsdk`。**我們的 CI 要自己寫 Dockerfile，鎖定 emsdk 與 libav.js tag。**

**Engine 需要的元件都在 FFmpeg 的範圍內 [已查證：fragment 或 FFmpeg 元件存在]**

| 類別 | 建議 fragment |
|---|---|
| demuxer | `demuxer-mp4`（即 FFmpeg 的 `mov`）、`demuxer-matroska`、`demuxer-ogg`、`demuxer-wav`、`demuxer-flac`、`demuxer-mp3`、`demuxer-aac`、`demuxer-wavpack`（會打開 `wv` demuxer 與 `wavpack` decoder） |
| 音訊 decoder | `decoder-aac`、`decoder-mp3float`*、`decoder-alac`、`decoder-flac`、`decoder-opus`（FFmpeg 原生，不用 libopus）、`decoder-vorbis`（原生）、`decoder-wavpack`、`decoder-pcm_{s16le,s16be,s24le,s24be,s32le,s32be,f32le,f32be,f64le,f64be,u8}` |
| parser | `parser-aac`、`parser-mpegaudio`、`parser-flac`、`parser-opus`、`parser-vorbis`、`parser-h264`、`parser-hevc`、`parser-vp9`、`parser-av1`（CONFIG.md 說明 parser 主要用來在 seek 時找 keyframe，體積接近 0） |
| bsf（選配） | `bsf-extract_extradata`（官方 `webcodecs` variant 也有開） |

\* `decoder-mp3` 打開的是定點版 `mp3`；要 float 輸出就改用 `mp3float`。這只是一般的 FFmpeg 旗標，沒有專屬 fragment，命名規則請參考 CONFIG.md。**[推論]**

- 官方的 `webcodecs` variant（`configs/configs/webcodecs/config.json`）就是「demux 給 WebCodecs」的組合：ogg、webm、mp4、flac、wav，加上 aac、vp8、vp9、av1、h264、hevc 的 **parser（不含 decoder）**，以及 `extract_extradata` 等 bsf。這可以當作我們 config 的起點。
- **Annex B 轉 AVCC 不需要 bsf。** FFmpeg 本來就沒有 Annex B 轉 AVCC 的 bsf（只有反方向的 `h264_mp4toannexb`）。不過 W3C AVC registration 明訂：「If the description is not present, the bitstream is assumed to be in annexb format.」所以遇到 Annex B（例如 extradata 以 `00 00 00 01` 開頭）時，**不帶 `description`** 就行。libavjs-webcodecs-bridge 的 `videoStreamToConfig` 正是這麼做的（`extradata[0] === 0` 時不設 description）。MP4 與 MKV 的 H.264 extradata 本來就是 avcC，可以直接當 description 用。**[已查證：規格與 bridge 原始碼；Safari 是否接受 annexb 輸入 [未驗證]]**
- npm 與 GitHub Release 都**不會**發佈含 MPEG 專利 codec（AAC、H.264、HEVC）的 build；作者在 README 裡明確反對使用這類 codec。所以 **AAC、MP3 的 variant 一定要自己 build**，這點本來就符合 map 中「CI 在 Docker 內 build」的方向。

**體積估算 [推論，需實際 build 確認]**
`docs/fragment-sizes.csv`（以 6.9.8.1 量測，單位 KiB，wasm）：empty 178、avformat 299、avcodec 157、avfcbridge 39、avbsf 50；demuxer：mp4 271、matroska 71、ogg 52、wav 50、flac 27、mp3 17、aac 9；decoder：aac 388、mp3 67、alac 34、flac 47、wavpack 53、各 pcm 約 28（共用程式碼，不會線性疊加）。原生 opus、vorbis decoder 不在 CSV 裡；libopus 145、libvorbis 141 可以當上限參考。
直接加總約 **1.8–2.1 MiB wasm**（未壓縮；fragment 之間有共用程式碼，實際會更小）。另外還有 glue JS，README 寫「up to 408KiB, but is highly compressible」。README 也說一般完整 build 的 wasm 大約 1.5–3 MiB。

## 2. 讀檔：非同步自訂讀檔 device

**block reader device 正好符合需求 [已查證]**（`docs/IO.md`、`src/p-avformat.in.js`）
- `await libav.mkblockreaderdev(name, size)`：大小固定、可隨機存取。FFmpeg 讀取時會呼叫 `libav.onblockread(name, position, length)`，我們再用 `libav.ff_block_reader_dev_send(name, pos, Uint8Array)` 回送資料。**`onblockread` 可以是 async function**，所以裡面要用 `fetch` 加 `Range` 都可以。
- 回送的資料可以比要求的多或少。device **只會記住最近一次送來的那一塊**；之後的讀取只要落在這塊範圍內，就同步回應，不會再觸發 `onblockread`（`blockReaderCallbacks.read`）。因此預讀和 LRU 快取要放在我們自己的 `onblockread` 裡實作，每次回送一大塊，例如 256 KiB。
- 超過 `size` 的讀取會自動回 EOF。
- 檔案大小要事先知道，可以先發 HEAD，或用第一個 Range 回應的 `Content-Range` 取得，這與 map 的「先取得檔案大小」一致。
- 另外有 `mkreadaheadfile(name, Blob)`，適合 Blob 或 File 來源，可以用在測試或本機檔案。`jsfetch:` protocol 標為實驗性質，**不支援 seek**，不採用。

**中止進行中的 read：可以，但有後遺症 [已查證機制；後遺症為推論]**
- 如果 `onblockread` 丟出例外，或回傳的 promise reject，libav.js 會呼叫 `ff_block_reader_dev_send(name, pos, null, {error: ex})`。FS read 會丟出 `ECANCELED`；在 `returnsErrno` 的 wrapper（例如 `av_read_frame`、`avformat_open_input`、`avformat_find_stream_info`、`av_seek_frame`）裡，這會 **rethrow 原本的例外物件**（`tools/mk-post.js`；測試 `619-block-reader-error-passthru.js`）。所以 AbortSignal 可以把 AbortError 一路傳到正在 await 的 libav.js 呼叫。
- **一定要回應，不能放著不管。** FFmpeg 的 `file_read` 被 patch 成「`EAGAIN` 時呼叫 `libavjs_wait_reader` 等待」（`patches/ffmpeg/01-blocking-reader.diff`）。如果 `onblockread` 永遠不 resolve 也不 reject，wasm 就會一直停在 Asyncify 的暫停狀態，而這個 instance 後面所有序列化的呼叫都會跟著卡住。
- **後遺症：** 錯誤會讓 FFmpeg 的 `AVIOContext` 設下 `s->error`（`aviobuf.c` 的 `fill_buffer` 與 `avio_read`），而 `avio_seek` 只會清掉 `eof_reached`，**不會清 `error`**。`matroskadec.c` 會直接檢查 `pb->error`，`demux.c` 遇到 EOF 時也會把 `pb->error` 往上回報。所以中止之後，這個 `fmt_ctx` 應該視為已經失效。block device 本身也會一直保留錯誤，直到下一次 `ff_block_reader_dev_send` 才會清掉。**[推論，需 prototype 確認]**
  - 對策 A（不需要 C）：中止後執行 `avformat_close_input_js`，再重新呼叫 `ff_init_demuxer_file`。重新 probe 時讀到的資料大多會命中我們的快取，再 seek 回目標位置即可。
  - 對策 B（不需要 C）：seek 時**不中止**正在進行的那一塊。網路 fetch 可以先取消，再對同一個位置重新發出請求，讓 FFmpeg 拿到資料後再執行 seek。等待時間最多就是一塊的下載時間，可以設 timeout，逾時就退回對策 A。
  - 對策 C（少量 patch）：在 libav.js wrapper 補上 `AVIOContext_error_s` accessor 來重設錯誤。不建議為了這點特地加 patch。
  - `destroy()`：直接丟掉整個 instance（見第 5 節），不用處理上面這些狀態。

**seek 行為 [已查證]**
- 可以用 `av_seek_frame`、`avformat_seek_file`，以及 `_min`、`_max`、`_approx` 這幾個變體。它們都是 async，會觸發讀取（`funcs.json`；測試 `615-seek.js`）。
- 因為 `WASM_BIGINT=0`，int64 時間戳要拆成 `(lo, hi)` 兩個 number 傳入，例如 `av_seek_frame(fmt_ctx, idx, tsLo, tsHi, flags)`。這只是 API 的寫法比較彆扭，不是缺口。
- seek 之後，decoder 要用 `avcodec_flush_buffers(c)` 清掉狀態（已 export）。「解碼後丟到目標時間、精準到 sample」這段邏輯由我們自己寫，本來就在 Engine 的範圍內。

## 3. 同步讀與非同步的銜接、COOP/COEP

- **libav.js 用的是 Asyncify**（`-s ASYNCIFY`），沒有 JSPI build。**[已查證：`Makefile.m4`]**
- Asyncify 產生的是一般的 wasm，所有瀏覽器都能跑，包含 Safari 與 iOS Safari。代價是程式碼變大、執行變慢；Emscripten 文件說它「can cause the Wasm output to be much larger」，並建議用 `-O3` 之類的最佳化（libav.js 用的是 `-Oz`）。**[已查證：emscripten `asyncify.rst`、`settings.js`]**
- **不需要 COOP/COEP。** 只有 `yesthreads`（threaded build，需要 SharedArrayBuffer）才需要 cross-origin isolation。預設的 `wasm` target 是單執行緒；`LibAV.target()` 只有在 `opts.yesthreads` 有設、而且 `isThreadingSupported()` 為真時，才會選 `thr`（`src/frontend.in.js`）。音訊解碼和 demux 不需要 threads。**[已查證]**
- 結論：map 提出的三個選項（Asyncify、JSPI、SAB + Atomics）之中，**libav.js 已經替我們選了 Asyncify**，而且完全符合「COOP/COEP 視為明顯代價」這個前提。

**Asyncify 的序列化限制 [已查證機制]**
- 所有 async 的 C 函式與 meta function（`ff_init_demuxer_file`、`ff_read_frame_multi` 等）都會經過同一條 `serially()` promise chain（`src/post.in.js`、`tools/mk-post.js`）。所以**同一個 instance 一次只能有一個 async 操作**；Emscripten 文件也寫明「It is *not* safe to start an async operation while another is already running」。
- 這個 chain 存在於每個 Module 內部（MODULARIZE），所以**不同 instance 之間不會互相阻塞**。
- 影響：
  - 主檔和外掛音軌如果放在同一個 instance，一邊網路卡住，另一邊也會跟著停。**每個來源要用自己的 instance。**
  - `ff_decode_multi` 呼叫的 `avcodec_send_packet`、`avcodec_receive_frame` 都是同步函式，不經過 `serially`。但在 demux 的讀取被 Asyncify 暫停的期間，再同步呼叫同一個 instance 的 decode 是否安全，**[未驗證]**。測試 `616-reentrancy.js` 裡的 `onblockread` 是同步回送資料，沒有真的進入暫停狀態，所以無法證明這種情況安全。**保守做法是 demux 與 decode 用不同的 instance**，這樣網路卡住時，已經讀進來的封包仍然可以繼續解碼。

## 4. API 涵蓋度

| 需求 | libav.js 提供 | 狀態 |
|---|---|---|
| 開檔、probe | `ff_init_demuxer_file(name)`：內部執行 `avformat_open_input` 加 `avformat_find_stream_info`，回傳 `[fmt_ctx, Stream[]]` | 有 |
| 容器格式 | `AVFormatContext` 沒有 `iformat` accessor；不過 `ff_init_demuxer_file` 可以強制指定 `format`。要取得容器名稱需要另外補 | **小缺口**（不影響播放，用副檔名或 MIME 就夠） |
| 總長度 | `AVFormatContext_duration` / `durationhi`（AV_TIME_BASE）、`Stream.duration` | 有 |
| 各軌 codec | `Stream.codec_type`、`codec_id`、`avcodec_get_name(id)`、`ff_copyout_codecpar(ptr)`（sample_rate、channels、profile、level、width、height、color_*、extradata、coded_side_data） | 有 |
| 語言、標題 | `Stream.metadata`（`ff_copyout_dict`；matroska、mov 的 `language` 與 `title` 都放在這裡） | 有 |
| default／forced | **`AVStream.disposition` 沒有 accessor**，`Stream` 物件裡也沒有（`src/b-avformat.c` 只有 codecpar、discard、duration、metadata、time_base） | **缺口** |
| 只讀選中的軌 | `AVStream_discard_s(st.ptr, libav.AVDISCARD_ALL)`（測試 `617-discard.js`） | 有（被 discard 的軌，資料是否仍會從網路讀進來，取決於容器的交錯方式 [推論]） |
| seek | 見第 2 節 | 有 |
| codecpar／extradata 轉 WebCodecs description | `ff_copyout_codecpar` 會給出 `extradata` 的 Uint8Array；libavjs-webcodecs-bridge 的 `audioStreamToConfig` 與 `videoStreamToConfig` 會組出 codec string 與 description（avcC、hvcC、AudioSpecificConfig、flac、vorbis），`packetToEncodedVideoChunk` 會轉換封包 | 有（bridge 0.3.2，ISC 授權，最後發佈 2024-12） |
| 旋轉 | `coded_side_data`（display matrix）可以從 `ff_copyout_codecpar` 取得 | 有 [推論] |
| time_base、start_time | `Stream.time_base_num` / `den`；`AVFormatContext_start_time`；Packet 帶 `pts`/`ptshi`、`dts`/`dtshi`、`duration`、`time_base_*`、`flags`（keyframe） | **每條軌的 `start_time` 沒有 accessor**，可以改用第一個封包的 pts，或容器層的 `start_time` |
| 同時開多個 demuxer | 同一個 instance 可以開多個 `fmt_ctx`（測試 `616-reentrancy.js`），但 async 呼叫會排隊。建議每個來源用一個 instance | 有（受第 3 節的限制） |
| chapters（[延]） | `ff_get_demuxer_chapters` | 有 |
| 音訊輸出格式 | `ff_decode_multi` 回傳 `Frame`；planar 時 `data` 是每個 plane 一個 typed array。aac、mp3float、opus、vorbis 的原生 decoder 輸出 fltp；flac、alac、wavpack、pcm 輸出整數格式。轉成 float 可以在 JS 做，也可以加 `swresample`（74 KiB） | 有 |

## 5. Worker 模式、記憶體上限與釋放

- **執行模式 [已查證]**（`docs/API.md`、`src/frontend.in.js`）：`worker` 是預設，每個 instance 各開一個自己的 Worker，I/O callback 會透過 postMessage 回到建立它的執行緒。`direct` 模式用 `noworker: true`，在呼叫端的執行緒上直接跑。`threads` 模式需要 `yesthreads` 和 COOP/COEP，不採用。
- **建議**：Engine 自己的 demux／decode Worker 以 `noworker: true` 載入 libav.js。README 也說：「if you're loading libav.js *in* a worker, it may be reasonable to set `noworker`」。這樣 `onblockread`、fetch、快取都在同一個 Worker 裡，不會多一次 postMessage，Packet 和 Frame 的 ArrayBuffer 也可以直接 transfer 給主執行緒。
- **bundler**：可以用 `factory`（自己 import 進來的 factory）、`wasmurl`（Vite 產生、帶 hash 的 asset URL）、`toImport`、`noes6` 這些選項覆寫載入方式（README「Bundlers」）。wasm 是否走 streaming compile，取決於 Emscripten 的預設行為。**[未驗證]**
- **記憶體上限**：預設是 `INITIAL_MEMORY=24MiB` 加上 `ALLOW_MEMORY_GROWTH`，沒有設定 `MAXIMUM_MEMORY`，所以使用 Emscripten 的預設 2 GiB（`settings.js`）。fragment 支援 `link-flags.txt`，自訂 fragment 應該可以加上 `-s MAXIMUM_MEMORY=…`。**[推論，未實測旗標順序]**
- **釋放**：`avformat_close_input_js`、`ff_free_decoder`、`av_packet_free_js` 等函式會把記憶體還給 malloc。但 **WebAssembly memory 只能增長、不能縮小**，所以要把記憶體真正還給瀏覽器，**只能丟掉整個 instance**：worker 模式呼叫 `libav.terminate()`；direct 模式則放掉所有參照，讓 GC 回收，或直接 terminate 我們自己的 Worker。**[已查證：terminate 實作；不能縮小是 WebAssembly 的語意]**
- **建議的 `destroy()` 做法**：中止我們這一層的 fetch，然後直接丟掉 instance（或 terminate Worker），不必等 libav.js 的呼叫 resolve。這也能避開第 2 節提到的 `pb->error` 問題。

## 6. 字幕封包：內嵌 ASS

- **CodecPrivate 會放在 extradata [已查證]**：`matroskadec.c` 的處理是：如果某條軌還沒有 extradata、而 `codec_priv.size > extradata_offset`，就把 CodecPrivate 複製成 `par->extradata`；字幕軌的 offset 為 0。只要用 `ff_copyout_codecpar(stream.codecpar).extradata` 就能取得 ASS header 原文（`[Script Info]`、`[V4+ Styles]` 等）。
- **event 原文就是封包內容 [已查證]**：matroskadec 對 `S_TEXT/ASS` 沒有做任何轉換，block 的資料原封不動成為 packet data，也就是 Matroska 字幕規格裡的 `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`。開始與結束時間來自 packet 的 `pts` 和 `duration`，而 libav.js 的 Packet 物件都有這兩個欄位。
- 不需要開任何字幕 decoder，只要有 demuxer 就夠了。

## 7. 授權、發佈形式與維護狀態

- **授權 [已查證]**：FFmpeg 部分是 LGPL 2.1（build 出來的檔案開頭帶有完整的 license header，見 `configs/fragments/default/license-head.js`）。libav.js 自己的 wrapper 是 0BSD。npm 上標示為 `LGPL-2.1`。README 與 LICENSE.md 要求：發佈編譯產物時**必須提供原始碼**；如果改了會連結進 FFmpeg 的部分，也要公開這些修改。
- **對 Engine 的意義**：我們發佈 Release tarball 時，要附上（或提供連結到）FFmpeg 原始碼 tarball、libav.js 對應 tag 的原始碼、我們的 variant config，以及任何 patch（例如第 4 節的 accessor patch）。libav.js 的 `make release` 會用 `*-release` target 把各個依賴的原始碼打包進 `sources/` 目錄（`Makefile.m4`），我們的 CI 可以照做。**檔案開頭的 license header 不能刪掉。**
- **npm 發佈形式 [已查證]**：`libav.js`（全部 variant，unpacked 約 179 MB）、`@libav.js/variant-<name>`（單一 variant，例如 `variant-webcodecs` 約 15.7 MB unpacked）、`@libav.js/types`（只有 `.d.ts`，README 推薦用在 TypeScript）。modular variant（每個 demuxer 或 decoder 各一包）只在 GitHub Release 上有，npm 沒有。
- **版本號 [已查證]**：版本格式是「libav.js 主版本.次版本.FFmpeg 主版本」，例如 6.10.9 就是 libav.js 6.10 搭配 FFmpeg 9.0；GitHub tag 再多帶 FFmpeg 的次版本號，例如 `v6.10.9.0`。檔名本身就含版本號，cache-busting 方便。
- **維護狀態 [已查證：GitHub API、npm time]**：單一主要維護者（Yahweasel），約 530 stars，沒有 archive。最近幾次發佈：6.10.9（2026-08-18，升到 FFmpeg 9.0）、6.9.8（2026-06-29）、6.8.8（2025-09-02）、6.7.7（2025-06-17）；2024 年秋天幾乎每週都有一版。節奏大約是 2 到 6 個月一版，並跟著 FFmpeg 主版本走。最近一次 commit 在 2026-08-31（加入 dav1d decoder variant，和 map 裡 [延] 的 dav1d 備案有關）。
- **風險**：bus factor 是 1；bridge 套件（0.3.2）已經快兩年沒更新。不過我們會鎖定 tag、自己 build，bridge 的邏輯也很少（`src/demux.ts` 只有幾百行），必要時可以 vendor 進來。

## 8. 缺口與最小補法

| 缺口 | 影響 | 最小補法 | 需不需要 C |
|---|---|---|---|
| npm 沒有符合需求的 variant | 必須自己 build | 在 Docker 裡 checkout 固定的 libav.js tag，執行 `mkconfig.js kikoeru '[…]'` 和 `make build-kikoeru` | 不需要 |
| `AVStream.disposition` 沒有 accessor | 拿不到 default／forced | 在 build 時對 `src/b-avformat.c` 加 `B(int, disposition)`、`BL(int64_t, start_time)`，`funcs.json` 的 AVStream accessors 加上對應名稱。這是 libav.js wrapper 的兩、三行 patch，不改 FFmpeg，並建議 upstream PR。備案：direct 模式下用 `copyout_s32(st.ptr + offsetof)` 直接讀記憶體，但這依賴 ABI，不推薦 | 只是 wrapper 的巨集，不算 shim |
| 每條軌的 `start_time` 沒有 accessor | 時間戳偏移 | 同上的 patch；或改用第一個封包的 pts 加容器的 `start_time` | 同上，或不需要 |
| 容器名稱（`iformat->name`） | 只用在診斷 | 同一個 patch 一起補，或省略 | 同上 |
| 中止讀取後 `pb->error` 會殘留 | seek 時中止讀取，demuxer 就壞掉 | seek 時讓進行中的那一塊讀完（對策 B），逾時就重開 demuxer（對策 A）；destroy 直接丟 instance | 不需要 |
| 同一個 instance 的 async 呼叫會排隊 | 網路卡住時其他操作也停 | 每個來源一個 instance，demux 和 decode 分開 instance（待 prototype 驗證） | 不需要 |
| WebCodecs config 組裝 | — | 直接用或 vendor libavjs-webcodecs-bridge；Annex B 時不帶 description | 不需要 |

**不建議**放棄 libav.js 改用自己的 FFmpeg build。上表的缺口都很小；如果自己 build，等於要重寫 block device、Asyncify 的 import 清單、FS 錯誤傳遞、accessor 產生器與 TS 型別，這些正是 libav.js 已經做好的部分。

## 9. 建議交給 prototype 驗證的事項

1. 自訂 variant 的實際 wasm 與 glue 體積（gzip 和 brotli 都要量）。
2. 在 `noworker` 模式下，同一個 instance 的 demux 讀取被 Asyncify 暫停時，同步的 `ff_decode_multi` 是否安全；或直接採用拆開 instance 的做法。
3. 中止讀取後，`fmt_ctx` 是否真的不能再用（matroska 和 mov 各測一次），以及重開 demuxer 的成本。
4. iOS Safari 上 Asyncify build 的效能，以及多個 instance（每個初始 24 MiB）的記憶體壓力。
5. Safari 的 WebCodecs 是否接受 Annex B（不帶 description）的 H.264。

## 來源

- libav.js repo（`master`，2026-08-31）：`README.md`、`docs/API.md`、`docs/IO.md`、`docs/CONFIG.md`、`docs/fragment-sizes.csv`、`Makefile.m4`、`mk/ffmpeg.mk`、`funcs.json`、`src/b-avformat.c`、`src/p-avformat.in.js`、`src/p-avfcbridge.in.js`、`src/post.in.js`、`src/frontend.in.js`、`tools/mk-post.js`、`patches/ffmpeg/01-blocking-reader.diff`、`configs/configs/webcodecs/`、`configs/mkconfigs.js`、`tests/tests/{615,616,617,619}-*.js`、`LICENSE.md` — https://github.com/Yahweasel/libav.js
- libav.js releases 與 repo metadata：GitHub API `repos/Yahweasel/libav.js`（releases、commits）
- npm：`npm view libav.js`、`@libav.js/variant-webcodecs`、`libavjs-webcodecs-bridge@0.3.2`（套件原始碼 `src/demux.ts`）
- FFmpeg 原始碼（`master`）：`libavformat/aviobuf.c`、`libavformat/demux.c`、`libavformat/matroskadec.c`（無任何 ASS 專屬處理）、`libavformat/matroska.c`（`S_TEXT/ASS`、`S_TEXT/SSA` → `AV_CODEC_ID_ASS`）、`libavformat/avformat.h` — https://github.com/FFmpeg/FFmpeg
- Emscripten：`site/source/docs/porting/asyncify.rst`、`src/settings.js`（`ASYNCIFY`、`JSPI`、`MAXIMUM_MEMORY`）— https://github.com/emscripten-core/emscripten
- W3C：AVC (H.264) WebCodecs Registration — https://www.w3.org/TR/webcodecs-avc-codec-registration/
