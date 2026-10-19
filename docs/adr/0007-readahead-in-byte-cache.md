# 預讀放在 bytes 層的 Range 快取，封包佇列只做 demux 與解碼之間的緩衝

往播放位置之後事先抓取資料（**預讀**）發生在 media Worker 的 Range 快取：每個選用中的來源以 `readaheadSeconds` × 位元組率為目標成批抓取，達到目標就停，掉到一半以下才恢復。demux 之後的封包佇列只保留約 2 秒，是內部常數，不再對外提供 `packetQueueSeconds`。記憶體因此只有一個對外的上限 `cacheBytes`，主來源與外掛音軌共用一個 LRU。這是 Chromium（multibuffer）與 Firefox（MediaCache）的做法。

## Considered Options

- **以封包佇列的秒數往前緩衝，快取只負責對齊與往回 seek**：`buffered` 會是精確的媒體時間，但同一段資料要存兩份（快取的原始 bytes 與封包複本）。高碼率影片以秒數計時佔用很大（40 Mbps × 30 秒約 150 MB），還要另外加 bytes 上限。交錯不良的檔案在 bytes 上限下會卡死：影片封包塞滿佇列，下一個音訊封包還沒讀到，音訊時鐘停住，影片也跟著等。

## Consequences

- 位元組率的初始值用所有音訊與影片軌 `bit_rate` 的合計：libav.js 沒有 `AVFormatContext.bit_rate` 的 accessor，FFmpeg 在容器沒有記錄時也是這樣估，不為此加 wasm patch。合計少算了容器的 overhead，播放中再依 demux 實際讀到的 byte 位置與 pts 修正。有一條軌沒有記錄 `bit_rate` 時改用「檔案大小 ÷ duration」，兩者都沒有時用保守的預設值。
- `buffered` 因此是估計值：http 來源最多一段，從 `currentTime` 起算，長度是 `bufferAhead`（封包佇列的秒數加上預讀 bytes 換算的秒數）；播放位置之前、仍在快取中的資料不列入。`bytes`／`blob` 來源整個在本機，`buffered` 為 `[0, duration]`。CBR 音訊幾乎精確，VBR 與影片有誤差；`buffered` 只用來畫進度條，所以可以接受。
- 往前 seek 落在預讀範圍內時直接命中快取。成批抓取讓手機的網路晶片有空檔可以休眠。
- 單一來源的預讀最多用掉 `cacheBytes` 的 75%，剩下的留給播放位置之前的資料，讓往回 seek 也能命中。
- 交錯不良的檔案仍需要封包佇列暫時變大：只要某條選用中軌道的佇列是空的，就允許超過平常的上限繼續 demux，直到硬上限；超過硬上限時是 fatal 的 `MEMORY_LIMIT`，不退回只播音訊。
