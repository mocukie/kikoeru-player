# FFmpeg 透過自 build 的 libav.js variant，以 Asyncify 銜接，不要求 COOP/COEP

Engine 的 demux 與音訊解碼使用 libav.js 的自訂 variant：釘 libav.js tag，build 時對其 0BSD wrapper 套上我們自己的小 patch（`disposition`／`start_time`、`AVIOContext` 的 `error`／`eof_reached`、容器格式名稱的 accessor），不 fork，patch 也不提給 upstream。wasm 同步讀與非同步 fetch 的銜接沿用 libav.js 的 Asyncify，每個來源一個 instance，demux 與 decode 共用。選擇 Asyncify 是因為它涵蓋全部的支援範圍（近兩年的 Chromium、Firefox、Safari），而且不需要 cross-origin isolation。

## Considered Options

- **自己 build FFmpeg 並寫 JS glue**：libav.js 的 API、block reader device 與 build 系統已經足夠，缺口只要幾行 accessor 就能補上。Engine 只透過自己的薄介面使用 libav.js，日後要改走這條路，只影響這一層。
- **JSPI**：體積小約 19%、速度快 13–42%，但 Chrome 130–136、Firefox 132–152、Safari 18／26 都不支援，單靠 JSPI 會讓 iOS 26 的使用者無法播放。「JSPI + Asyncify 雙 build」會讓 CI 產物與測試矩陣翻倍，Asyncify 目前的速度已經夠用，所以 v1 不做。
- **SharedArrayBuffer + Atomics**：需要 cross-origin isolation。Safari 不支援 COEP `credentialless`，kikoeru 與每個 App 都得全站送 `require-corp`，代價外溢到 Engine 之外。

## Consequences

- Engine **不得要求** COOP/COEP。
- 來源的讀取介面固定為 JS 端的 `read(offset, length, signal) → Promise`，日後換成 JSPI 或 SAB 只需要改銜接層。
- Asyncify 下，每個 instance 同時只能有一個 pending 的 read、seek 或 open，所以主媒體與每條外掛音軌各用一個 instance。
- libav.js 只有一位維護者。我們釘 tag 自己 build，upstream 停擺時要自己維護 wrapper 與 patch。
