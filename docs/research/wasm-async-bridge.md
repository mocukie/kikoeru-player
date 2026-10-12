# Research：wasm 同步讀與非同步 fetch 的銜接方式

- Ticket：[#4](https://github.com/mocukie/kikoeru-player/issues/4)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)）
- 查證日期：2026-10-12
- 瀏覽器範圍（map Notes）：近兩年的 Chromium、Firefox、Safari（含 iOS Safari）。以查證日往回推兩年，下限大約是 Chrome 130、Firefox 132、Safari 18.1（2024-10 釋出）。
- 標記：**[已查證]** 有一手來源佐證；**[推論]** 由一手來源推得、沒有直接寫明；**[未查證]** 沒找到一手來源，要用 prototype 或實機確認。

## 問題

FFmpeg 的 `AVIOContext` 讀檔 callback（`read_packet`）是同步的，HTTP Range 讀取（`fetch`）是非同步的，兩者要怎麼銜接。ticket 列出三種做法：

1. **Asyncify**：Binaryen 的 code transform，把 wasm 改寫成可以 unwind／rewind。
2. **JSPI**（JavaScript Promise Integration）：由 VM 做 stack switching。
3. **Worker 內 `SharedArrayBuffer` + `Atomics.wait`**：demux 的 Worker 直接 block 等資料。

調查時另外看了兩個常被提到的替代方案（§5），一併放進比較。

## 1. Asyncify

### 1.1 機制與 Worker

- Asyncify 是 compile 時的 transform，執行時不需要任何瀏覽器功能，所以在 Worker 內可以使用，所有瀏覽器都支援 **[推論]**。實例：libav.js 每個 build 都開 `-s ASYNCIFY`，把 `ASYNCIFY_IMPORTS` 限縮在 reader 相關的 import（`libavjs_wait_reader`、`jsfetch_read_js` 等），預設就跑在 Worker 裡 **[已查證]**（[libav.js `Makefile.m4`](https://github.com/Yahweasel/libav.js/blob/master/Makefile.m4)、[libav.js `docs/IO.md`](https://github.com/Yahweasel/libav.js/blob/master/docs/IO.md)）。
- emscripten 的寫法：用 `EM_ASYNC_JS`，或在 JS library function 上標 `__async`，C 端仍是同步呼叫。同一份原始碼用 `-sASYNCIFY` 或 `-sJSPI` 都能 build，只差 link flag **[已查證]**（[emscripten Asyncify 文件](https://emscripten.org/docs/porting/asyncify.html)、[emscripten ChangeLog](https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md)）。
- 同步的快速路徑：`Asyncify.handleSleep` 如果在 `startAsync` 內同步呼叫 `wakeUp`，就不會 unwind（「if the code decided to call our callback synchronously, then no async operation was in fact begun」）。快取命中時可以直接回傳，不用付 unwind／rewind 的成本 **[已查證]**（[`src/lib/libasync.js`](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libasync.js)）。

### 1.2 bundle 體積與執行效能

- emscripten 文件：overhead「usually not extreme, something like 50% or so」；settings 文件說 `ASYNCIFY` 「has a significant cost in terms of code size and speed」**[已查證]**（[Asyncify 文件](https://emscripten.org/docs/porting/asyncify.html)、[settings reference](https://emscripten.org/docs/tools_reference/settings_reference.html)）。
- Asyncify 作者的量測：code size 大約是原本的 1–2 倍；speed 大致跟 size 成比例（大 20% 約慢 20%）；有 interpreter 型巨大函式的 SQLite 是例外，慢了約 5 倍。沒有 optimize 時體積會非常大，一定要 `-O2` 以上 **[已查證]**（[Pause and Resume WebAssembly with Binaryen's Asyncify](https://kripken.github.io/blog/wasm/2019/07/16/asyncify.html)）。
- **對 FFmpeg 不利的地方**：Asyncify 縮小 instrument 範圍靠的是 call graph 分析，indirect call 會讓分析失效。FFmpeg 的讀取路徑全是 function pointer：`fill_buffer` → `read_packet_wrapper` → `s->read_packet`（[`aviobuf.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/aviobuf.c)），demuxer 也透過 `ffifmt(s->iformat)->read_packet` 呼叫（[`demux.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/demux.c)）。所以 `ASYNCIFY_IGNORE_INDIRECT` 不能用，libavformat 幾乎整個會被 instrument **[推論]**。
- 可以壓低成本的地方：libavcodec 的 decoder 本身不會呼叫 read，可以用 `ASYNCIFY_REMOVE`（支援 wildcard）把 decoder 與 swresample 排除，讓音訊解碼的 hot loop 不付 Asyncify 的成本 **[推論]**。`avformat_find_stream_info` 雖然會在讀取過程中呼叫 decoder，但 decoder 不在「unwind 時的 stack」上，所以排除是安全的。仍要用 `ASYNCIFY_ADVISE` 確認 **[未查證]**。
- **實際增幅沒有 FFmpeg 的公開數字** **[未查證]**。要在 build pipeline 的 prototype 中，用 Engine 選定的 FFmpeg 設定（只開需要的 demuxer／decoder／parser）實測：wasm 大小（含 gzip／brotli）、demux 吞吐量、音訊解碼速度。

### 1.3 Reentrancy 的限制

- 文件：「It is _not_ safe to start an async operation while another is already running.」等待期間其他事件可能進入 compiled code，全域狀態也可能被改掉 **[已查證]**（[Asyncify 文件](https://emscripten.org/docs/porting/asyncify.html)）。
- runtime 也有 assertion：「cannot have multiple async operations in flight at once」（[`libasync.js`](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libasync.js)）。也就是**每個 wasm instance 同時只能有一個在等待的 read** **[已查證]**。
- 對 Engine 的影響 **[推論]**：
  - 同時開多個 demuxer（外掛音軌）時，如果共用一個 instance，A 在等網路時 B 不能讀，兩條軌的預讀會互相卡住。要改成**每個 demuxer 一個 wasm instance**：`WebAssembly.Module` compile 一次，可以 `postMessage` 給其他 Worker，再各自 instantiate。代價是每個 instance 有自己的 linear memory。
  - 等待期間不能呼叫同一個 instance 的任何 export（包括 `free`、`seek`、`close`）。所有指令都要經過 per-instance 的佇列，等目前的呼叫 resolve 之後才執行。abort 只能在 JS 端進行（§4）。

## 2. JSPI

### 2.1 支援狀態與時程

| 瀏覽器 | 版本（釋出日） | 來源 |
|---|---|---|
| Chrome／Edge（桌面與 Android） | 137（2025-05-27） | webstatus.dev、MDN BCD、[V8 blog](https://v8.dev/blog/jspi) |
| Firefox（桌面與 Android） | 153（2026-07-21） | webstatus.dev、MDN BCD、[Firefox 153 release notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/153) |
| Safari（macOS、iOS） | 27（2026-09-14） | webstatus.dev、MDN BCD、[WebKit WWDC26 文章](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-saf) |

- webstatus.dev 的 `wasm-jspi` 在 2026-09-14 成為 **Baseline Newly available** **[已查證]**（[webstatus.dev API](https://api.webstatus.dev/v1/features?q=promise%20integration)、[MDN BCD `webassembly/api.json`](https://github.com/mdn/browser-compat-data/blob/main/webassembly/api.json) 的 `promising_static`）。
- 注意：V8 blog 寫「Chrome 137 and Firefox 139」，但 Firefox 139 的 release notes 沒有提到 JSPI，153 的 release notes 才寫「JavaScript Promise Integration (JS-PI) is now enabled」。以 Mozilla 自己的 release notes 為準 **[已查證]**。
- Safari 27 只出在 macOS 27、iOS／iPadOS 27 **[已查證]**（WebKit WWDC26 文章）。Apple 官方的 Safari 27 release notes 頁面是 JS render，抓不到內文；正式版是否含 JSPI 只靠 webstatus 與 BCD 確認，沒有讀到 Apple 的原文 **[部分查證]**。
- **對支援範圍的意義**：近兩年的範圍包含 Chrome 130–136、Firefox 132–152、Safari 18.x 與 26（iOS 18、iOS 26），這些都沒有 JSPI。**只靠 JSPI 達不到 map 的支援範圍**。要等到 Firefox 153 與 Safari 27 也落在兩年下限之後（大約 2028-09），JSPI 才能單獨成立 **[推論]**。

### 2.2 emscripten 的支援程度

- `-sJSPI`；`-sASYNCIFY=2` 已 deprecated，改用 `-sJSPI` **[已查證]**（[settings reference](https://emscripten.org/docs/tools_reference/settings_reference.html)）。
- emscripten 6.0.8（2026-08-20）：「The `JSPI` setting is no longer considered experimental」**[已查證]**（[ChangeLog](https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md)）。
- 要明確列出 `JSPI_IMPORTS`／`JSPI_EXPORTS`；`EM_ASYNC_JS` 與標了 `__async` 的 library function 不用列。被標成 async 的 export 一律回傳 Promise **[已查證]**。
- 一個 wasm 只能是 Asyncify 或 JSPI 其中一種。要同時支援就得 build 兩個變體，執行時用 `typeof WebAssembly.Suspending === 'function'` 選擇 **[推論]**。

### 2.3 效能

- JSPI 不改寫 wasm：「The code size will remain the same」**[已查證]**（[Asyncify 文件](https://emscripten.org/docs/porting/asyncify.html)）。所以沒有 §1.2 的體積與 hot loop 成本。
- suspend／resume「essentially constant time」，demo 中一次 JSPI 呼叫約 1 µs，遠小於 I/O 的毫秒級延遲 **[已查證]**（[V8 blog](https://v8.dev/blog/jspi)）。
- 新版 API：被 `WebAssembly.Suspending` 包住的 JS function 回傳非 Promise 時不會 suspend（「we only suspend when the JavaScript function actually returns a `Promise`」），快取命中可以同步回傳 **[已查證]**（[V8 blog: JSPI new API](https://v8.dev/blog/jspi-newapi)）。
- 2024 年曾有「從 JS 反覆進入 promising export 很慢」的回報（每次約 1 ms），後來 Chrome 改成重用 stack 後修正（[emscripten #21081](https://github.com/emscripten-core/emscripten/issues/21081)）。Firefox 與 Safari 的進出成本沒有找到量測 **[未查證]**。
- 目前的實作會配置固定大小、相當大的 stack，同時 suspend 的數量有上限（V8 blog: JSPI new API）。Engine 同時 suspend 的只有每個 demuxer 一個，影響不大 **[推論]**。

### 2.4 Reentrancy 與 Worker

- 規格允許其他 export 在 suspend 期間執行，但「JSPI does not guarantee that the updates are completed in any particular order」，共享狀態的安全由開發者負責 **[已查證]**（[JSPI explainer](https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md)）。
- 只有 wasm frame 可以被 suspend；export 與 import 之間如果夾著 JS frame 會 trap **[已查證]**（同上）。read callback 必須直接由 wasm 呼叫 import，不能經過 JS 的 `dynCall` 轉手。
- emscripten 的 C shadow stack（linear memory 裡的 `__stack_pointer`）在多個 computation 同時 suspend 時會不會被正確保存，沒有找到一手說明。Pyodide 的文章指出 JSPI 只切換 wasm 原生 stack，shadow stack 要自己處理（[Pyodide: JSPI with C runtime](https://blog.pyodide.org/posts/jspi-with-c-runtime/)）**[未查證]**。保守做法跟 Asyncify 一樣：每個 instance 同時只跑一個 promising 呼叫，每個 demuxer 一個 instance。
- JSPI 是 JS API 層的功能，不限主執行緒，Worker 內可以使用 **[推論]**。webstatus 與 BCD 沒有分開列 Worker 的支援。

## 3. Worker 內 SharedArrayBuffer + Atomics.wait

### 3.1 機制

demux Worker 執行 wasm，read callback 在 SAB 上 `Atomics.wait`。另一個執行緒（主執行緒或 IO Worker）做 `fetch`，把資料寫進 SAB 的 ring buffer，再 `Atomics.notify`。wasm 不用任何 transform，也沒有 reentrancy 問題。

- `Atomics.wait`「is blocking and cannot be used in the main thread」，在主執行緒呼叫會丟 `TypeError`。可以在 dedicated Worker 中使用 **[已查證]**（[MDN `Atomics.wait()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait)）。
- 副作用 **[推論]**：demux Worker block 時，它的 event loop 也停住，`postMessage` 送來的指令要等 read 返回才會處理。控制訊號（abort、destroy）必須走 SAB，不能走 `postMessage`。fetch 不能在同一個 Worker 做，至少要多一個執行緒。

### 3.2 瀏覽器支援

| 功能 | Chrome | Firefox | Safari／iOS Safari | 來源 |
|---|---|---|---|---|
| `SharedArrayBuffer` 與 `Atomics.wait` | 68 | 79（`wait` 78） | 15.2 | MDN BCD、webstatus `shared-memory`（Baseline Widely available） |
| COOP、COEP `require-corp` | 83 | 79 | 15.2 | MDN BCD |
| COEP `credentialless` | 96 | 119 | **不支援** | MDN BCD `http.headers.Cross-Origin-Embedder-Policy.credentialless` |

- 有 cross-origin isolation 時，三家（含 iOS Safari 15.2+）都能用 SAB，**支援範圍沒問題** **[已查證]**。
- **Safari 不支援 `credentialless`**，所以要涵蓋 Safari 只能用 `require-corp` **[已查證]**。

### 3.3 對 kikoeru 的影響

- 後端要在 App 的 HTML 文件加上 **[已查證]**（[web.dev: COOP/COEP](https://web.dev/articles/coop-coep)）：
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- Worker script 也要套用 COEP（web.dev 建議 Worker 一起設），最簡單的做法是所有同源靜態資產都帶上這兩個 header **[推論]**。
- 在 `require-corp` 下，每個 subresource 都要同源，或帶 CORP（`Cross-Origin-Resource-Policy`）或 CORS。kikoeru 的封面依 kikoeru `CONTEXT.md` 的定義，平台封面會「快取在本地」，`WorkCoverResource` 由後端提供，**看起來是同源** **[推論，需在 kikoeru 端確認]**。只要有任何直連 DLsite／FANZA 的圖片、外部字型或 CDN，都會被擋。
- COOP `same-origin` 會讓跨源 popup 失去 `window.opener` 的往來（例如 OAuth popup）**[已查證]**（web.dev）。
- Engine 是給 App 用的 library。選這條路等於規定每個 App 都要 cross-origin isolated，這是外溢到 App 的部署限制 **[推論]**。kikoeru 先前的 movi-player 調查也建議不要開 COEP（kikoeru `docs/research/movi-player-capability.md` §1.3）。
- 好處：開了以後 emscripten pthreads 也能用（多執行緒解碼）。map 中「[延] 影片 wasm 軟體解碼」以後可能會想要，但 v1 的音訊解碼不需要 **[推論]**。

## 4. 各方案的 read 中止（AbortSignal → wasm）

FFmpeg 端的共通事實 **[已查證]**（[`aviobuf.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/aviobuf.c)、[`demux.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/demux.c)）：

- `read_packet` 回傳負值時，`fill_buffer` 會設 `s->eof_reached = 1` 與 `s->error = len`。`avio_read` 之後只要 `s->error` 不為 0 就直接回傳它。
- `avio_seek` 會把 `eof_reached` 清回 0，但**不會清 `s->error`**。abort 之後要繼續使用同一個 `AVIOContext`，必須自己把 `pb->error` 與 `pb->eof_reached` 歸零（兩個都是 public 欄位）。
- `AVFormatContext.interrupt_callback` 只在少數迴圈檢查（例如 `avformat_find_stream_info` 的主迴圈，檢查到就回 `AVERROR_EXIT`）。自訂 AVIO 的 read 不會經過它，**中止要由 read callback 自己回傳 `AVERROR_EXIT`**。

各方案的傳遞路徑：

| 方案 | read 等待中被 abort | wasm 在跑 CPU（沒有等 read）時被 abort | 延遲 |
|---|---|---|---|
| Asyncify | demux Worker 的 event loop 仍在跑。收到 abort → `AbortController.abort()` → `fetch` reject → async import 回傳 `AVERROR_EXIT` → rewind，demuxer 收到錯誤後一路返回 | Worker 正在跑 wasm，訊息要等到下一次 read 才處理。read callback 進入時先檢查 JS 端的 abort flag，有就直接回 `AVERROR_EXIT`（同步路徑，不 unwind） | 等待中：一個 task；CPU 中：到下一次 read |
| JSPI | 同 Asyncify：`fetch` reject → `Suspending` import 回傳錯誤碼 → resume | 同 Asyncify | 同 Asyncify |
| SAB + Atomics | 主執行緒或 IO Worker 在 SAB 寫 abort flag 並 `Atomics.notify` → read 醒來回 `AVERROR_EXIT`；IO 端同時 abort `fetch` | flag 在共享記憶體，`interrupt_callback` 與 read 進入時都能直接讀到，不用等 event loop | 最即時 |
| sync XHR（§5.1） | 無法中止。Worker 被 `send()` 卡住，只能等 timeout 或 `worker.terminate()` | 同左 | 最差 |

abort 之後的收尾（三種主要方案都一樣）**[推論]**：

- 中斷發生在 `avformat_open_input`／`avformat_find_stream_info`：這個 demuxer 視為作廢，`avformat_close_input` 後丟掉。
- 中斷發生在 `av_read_frame`：下一個指令一定是 seek（指令佇列中被取代的 seek，或新的 seek）。seek 前先用 C helper 把 `pb->error = 0`、`pb->eof_reached = 0`，再 `avformat_seek_file`／`av_seek_frame`，FFmpeg 會 flush 內部封包佇列。
- `destroy()`：abort 目前的 read，等該次 wasm 呼叫返回後再 `avformat_close_input`，最後丟掉 instance。Asyncify／JSPI 不能在 suspend 期間直接釋放 instance 的記憶體。要立刻回收時可以直接丟掉整個 instance（或 terminate Worker），只要 JS 端不再碰它即可。

## 5. 其他方案

### 5.1 Worker 內 sync XHR

- XHR 規格只在 `Window` 禁止同步請求的 `timeout` 與 `responseType`。在 Worker 中可以同步 `send()`，同時設 `responseType = 'arraybuffer'`、`timeout` 與 `Range` header。「Synchronous XMLHttpRequest outside of workers is in the process of being removed」，Worker 內不在移除範圍 **[已查證]**（[XHR Standard](https://xhr.spec.whatwg.org/)）。
- 不需要 COOP/COEP 與 transform，所有瀏覽器都能用 **[推論]**。
- 致命傷：**read 無法 abort**（Worker 卡在 `send()` 裡，同一個 Worker 沒辦法呼叫 `abort()`），這正是 spike 的 seek 卡住與 `destroy()` 停不下來的原因。只能靠 `terminate()` 整個 Worker 再重新 probe。另外，XHR 的錯誤分類比 `fetch` 粗。**不建議**。

### 5.2 非阻塞 AVIO（`AVERROR(EAGAIN)` 再重試）

- read 沒資料時回 `EAGAIN`，JS 補資料後重新呼叫。libav.js 只在 `ff_read_multi` 支援這種「push」模式，`ff_init_demuxer_file`（開檔 probe）仍要用 block reader（Asyncify）**[已查證]**（[libav.js `docs/IO.md`](https://github.com/Yahweasel/libav.js/blob/master/docs/IO.md)）。
- 從 `aviobuf.c` 看，`EAGAIN` 跟其他錯誤一樣會寫進 `s->error`，demuxer 內部的解析狀態不保證能重入 **[推論]**。probe、seek 與多數 demuxer 不安全，**不建議**當主要做法。

## 6. 比較

| | Asyncify | JSPI | SAB + Atomics.wait | sync XHR |
|---|---|---|---|---|
| 近兩年範圍的支援 | 全部 | **不足**（Chrome 137+、Firefox 153+、Safari 27+） | 全部（需 cross-origin isolation） | 全部 |
| COOP/COEP | 不需要 | 不需要 | **需要**，Safari 只能 `require-corp` | 不需要 |
| wasm 體積 | 增加（一般 ~50%，FFmpeg 實際值未測） | 不變 | 不變 | 不變 |
| 執行效能 | 被 instrument 的路徑變慢；可用 `ASYNCIFY_REMOVE` 排除 decoder | 原生；suspend 約 µs 級 | 原生；多一次跨執行緒複製 | 原生 |
| 每個 instance 同時等待的 read | 1 | 實務上 1（shadow stack 未查證） | 1（每個 demuxer 一個 Worker） | 1 |
| read abort | fetch reject → 錯誤碼，一個 task 內 | 同 Asyncify | SAB flag + notify，最即時 | **不能** |
| 執行緒架構 | demux Worker 內自己 fetch | 同 Asyncify | demux Worker + IO 執行緒，控制走 SAB | demux Worker |
| emscripten 狀態 | 穩定，libav.js 實績 | 6.0.8 起不再是 experimental | 不需特別支援（純 JS） | 不需特別支援 |
| 對 App 的外溢 | 無 | 無 | App 必須 cross-origin isolated | 無 |

## 7. 建議

1. **v1 採用 Asyncify**，在 demux Worker 內直接 `fetch`。只有它同時滿足三點：支援範圍涵蓋近兩年的三家瀏覽器、不需要 COOP/COEP、read 可以 abort。
2. **銜接層用 `__async` 的 JS library function（或 `EM_ASYNC_JS`）實作**，讓同一份 C 原始碼只改 link flag 就能換成 `-sJSPI`。快取命中走同步路徑（Asyncify 同步 `wakeUp`；JSPI 回傳非 Promise），只有 cache miss 才 suspend。
3. **JSPI 當作之後的升級**，不在 v1 實作。等 Firefox 153 與 Safari 27 落在支援下限之後（約 2028-09），或量測顯示 Asyncify 的體積或效能無法接受時，再加 JSPI build。要提早做的話，就是發 Asyncify 與 JSPI 兩個變體，用 `typeof WebAssembly.Suspending === 'function'` 選擇，代價是 CI 與測試矩陣加倍。
4. **SAB + Atomics 不用於 v1**：Safari 沒有 `credentialless`，kikoeru 必須全站 `require-corp` + COOP，而且這個限制會外溢到每個 App。設計上不要堵死：Engine 內的檔案來源介面維持 JS 端的 `read(offset, length, signal) → Promise`，wasm 只看到一個「同步 read」的 import，之後要換成 SAB 後端時只需替換這一層。
5. **由這個選擇衍生、要寫進 spec 的約束**：
   - 每個 demuxer 一個 wasm instance（`WebAssembly.Module` 共用）。
   - 同一個 instance 的所有呼叫經過佇列序列化，suspend 期間不呼叫任何 export。
   - abort 在 JS 端進行，read 回 `AVERROR_EXIT`。read 進入時先檢查 abort flag。abort 之後重設 `pb->error`／`pb->eof_reached` 再 seek；開檔中被 abort 就整個關掉。
6. **需要 prototype 實測的項目**（建議併進 FFmpeg build pipeline 的 research／prototype）：
   - 選定 FFmpeg 設定下，Asyncify 對 wasm 體積（gzip／brotli）與 demux、音訊解碼速度的影響，以及 `ASYNCIFY_REMOVE` 排除 libavcodec 後的差異。
   - `ASYNCIFY_ADVISE` 確認 instrument 範圍。
   - 多個 instance 的記憶體成本（每個 demuxer 的 linear memory）。

## 來源

- emscripten：[Asyncify 文件](https://emscripten.org/docs/porting/asyncify.html)、[settings reference](https://emscripten.org/docs/tools_reference/settings_reference.html)、[ChangeLog](https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md)、[`src/lib/libasync.js`](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libasync.js)、[issue #21081](https://github.com/emscripten-core/emscripten/issues/21081)
- Asyncify 原理與量測：[Pause and Resume WebAssembly with Binaryen's Asyncify](https://kripken.github.io/blog/wasm/2019/07/16/asyncify.html)
- JSPI：[V8 blog: JSPI](https://v8.dev/blog/jspi)、[V8 blog: JSPI new API](https://v8.dev/blog/jspi-newapi)、[JSPI explainer](https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md)、[Pyodide: JSPI with C runtime](https://blog.pyodide.org/posts/jspi-with-c-runtime/)
- 支援度：[webstatus.dev](https://webstatus.dev/)（API 查詢 `wasm-jspi`、`shared-memory`、`atomics-wait-async`）、[MDN browser-compat-data](https://github.com/mdn/browser-compat-data)（`webassembly/api.json`、`http/headers/Cross-Origin-Embedder-Policy.json`、`javascript/builtins/Atomics.json`、`javascript/builtins/SharedArrayBuffer.json`）、[Firefox 153 release notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/153)、[Firefox 139 release notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/139)、[WebKit: News from WWDC26](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-saf)
- Cross-origin isolation：[web.dev: Making your website cross-origin isolated using COOP and COEP](https://web.dev/articles/coop-coep)、[MDN `Atomics.wait()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait)
- XHR：[XMLHttpRequest Standard](https://xhr.spec.whatwg.org/)
- FFmpeg（master）：[`libavformat/aviobuf.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/aviobuf.c)、[`libavformat/demux.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/demux.c)
- libav.js：[`Makefile.m4`](https://github.com/Yahweasel/libav.js/blob/master/Makefile.m4)、[`docs/IO.md`](https://github.com/Yahweasel/libav.js/blob/master/docs/IO.md)
- kikoeru：[`CONTEXT.md`](https://github.com/mocukie/kikoeru/blob/main/CONTEXT.md)（封面）、[`docs/research/movi-player-capability.md`](https://github.com/mocukie/kikoeru/blob/main/docs/research/movi-player-capability.md)
