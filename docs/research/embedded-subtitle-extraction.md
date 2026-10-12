# Research：內嵌字幕整軌取出的代價

> 狀態：背景調查，尚未採用。結論供「內嵌字幕整軌取出的歸屬」grilling（#14）使用；本文只比較代價，不做決定。

- 對應 issue：mocukie/kikoeru-player#9（map：#1）
- 調查日期：2026-10-12
- 範圍：App 的歌詞面板需要**整條**內嵌字幕軌的 cue，但 MKV／MP4 裡字幕和影音交錯存放。比較兩條路：Engine 在瀏覽器內用 HTTP Range 取出，或 kikoeru 後端用 bytedeco FFmpeg 抽出；兩條路各自如何保留內嵌 ASS 的 header（CodecPrivate）與 event 原文。
- 一手來源：RFC 9559（Matroska）、draft-ietf-cellar-codec-16（Matroska codec mapping）、FFmpeg `n7.1` 與 `n9.0.2` 的 `libavformat` 原始碼、mkvmerge 文件（v82.0）、Emscripten Asyncify 文件、kikoeru 的 ADR-0001 與 `MediaProbe.java`、movi-player 0.4.1 原始碼。
- 實測環境：Docker `jrottenberg/ffmpeg:7.1-ubuntu`（FFmpeg 7.1）、同一 image 加裝 mkvtoolnix v82.0 與 strace 6.8；自寫的 Python EBML／MP4 box 掃描器與 HTTP Range server。測試檔放在 tmpfs，方法見附錄。

## TL;DR

1. **成本取決於「字幕 event 數」，不取決於檔案大小。** 在一個 971 MiB、24 分鐘、內嵌 792 個 ASS event 的 MKV 上：
   - 依照 Cues 只讀字幕 block：讀 **105–115 KB**（檔案的 0.01%），720 次 Range 請求。
   - 用 libavformat 只取字幕軌（其他軌 `AVDISCARD_ALL`）：**整個檔案從頭讀到尾**（1,018,266,379 bytes，strace 實測）。
2. **MKV 能做到「只讀字幕所在位置」，但 libavformat 做不到，要在 Engine 自己寫一個以 Cues 為索引的讀取器。**
   - RFC 9559 §22.1 建議每個字幕 frame 都要有 CuePoint，並帶 CueDuration 與 CueRelativePosition。FFmpeg 的 matroska muxer 與 mkvmerge（預設 `--cues` 對字幕軌是 `iframes`）實測都會把 792 個字幕 block 全部寫進 Cues，且帶 CueRelativePosition 與 CueDuration。
   - libavformat 的 `matroskadec` 會先把每個 SimpleBlock／Block 整個讀進記憶體，才檢查該軌是否 discard；它也不使用 CueRelativePosition（syntax 表裡是 `EBML_NONE`）。`n7.1` 與 `n9.0.2` 都一樣。
   - 改成「用 libavformat 的 index 對每個 cue seek 到 cluster 開頭再往下讀」也不行：字幕 block 落在 cluster 中段時，要讀 532 MB（檔案的 57%）。
3. **MP4 用 libavformat 就能只讀字幕 sample**：`mov.c` 從 `stbl` 建出每個 sample 的 offset 與大小，discard 的軌不 seek、也不讀。實測讀了 25 MB（moov 1.5 MB，加上 720 次 seek，每次填滿 32 KiB 的 avio buffer）。字幕 sample 本身只有 30 KB，Engine 的 AVIO 若不做大塊 read-ahead，可以壓到 2 MB 左右（估算）。**但 MP4 放不了 ASS**：FFmpeg 的 mp4 muxer 拒絕 ASS stream copy，只能轉成 `mov_text`，樣式會遺失。所以「內嵌 ASS」實務上只會出現在 MKV。
4. **兩條路都能完整保留 ASS 原文。**
   - CodecPrivate 會原樣出現在 `codecpar->extradata`，內容不只 `[Script Info]` 與 Styles：`[Events]` 的 `Format:` 行、所有 `Comment:` 行、非標準 section（`[Aegisub Project Garbage]`、`[Aegisub Extradata]`）也在裡面（FFmpeg 與 mkvmerge 實測都是這樣）。
   - 每個 Block 的內容就是 `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`，AVPacket 的 data 是原文，時間來自 Block timestamp 與 BlockDuration。
   - 用 FFmpeg（`-c copy -f ass`）或 mkvextract 重組回 `.ass` 時，非空白行與原檔完全一致，Dialogue 依 ReadOrder 回到原順序。改變的只有：BOM、CRLF、`Comment:` 行相對於 Dialogue 的位置。
5. **後端抽取的代價是「每個 MKV 讀一次整個檔案」**：本機讀檔是 I/O bound。tmpfs 上 0.54 秒讀完 1 GB，所以 libavformat 解析本身不是瓶頸。換成 HDD／NAS 估計 1–2 GB 需要約 7–18 秒（未實測）。結果只有幾十到幾百 KB，適合依 `(WorkFile, size, mtime, track)` 快取。
   - 主要風險是 ADR-0001 已經記錄的 native crash：抽取會把這個風險帶進 request 路徑，而目前的 ProbeGuard 只保護掃描。
   - 其次，Engine 與後端的 track 對應要另外約定。
6. **取消、進度、與播放並行**：
   - Cue 讀取器是純 TS 的 async 迴圈。讀完 Cues 就知道總數，進度精確；每個 fetch 都能接 AbortSignal；它不經過 wasm，所以能和播放並行。
   - 用第二個 libavformat 實例做全檔掃描時，進度只能用 byte 位置估算。如果 FFmpeg 用 Asyncify build，同一個 wasm instance 不能同時有兩個進行中的 async 呼叫（Emscripten 文件），必須另開 instance。movi-player 就因為這樣，在 prefetch 時必須暫停播放。

## 1. 前提

- Engine 的 [必] 項目已經包含「選中的內嵌字幕軌隨 demux 進度串流送出 cue」與「內嵌 ASS 保留 header（CodecPrivate）與 event 原文」。本題問的是**不等播放走完**就拿到整軌的代價。
- kikoeru 的前端字幕 research（kikoeru `docs/research/frontend-subtitle-handling.md`）結論：歌詞面板由 App 自己畫，需要完整 cue 清單。movi-player 的作法是 `getAllSubtitleCues()` 掃描整條字幕軌（kikoeru `docs/research/movi-player-capability.md` §7）。
- 後端讀檔是同源 HTTP Range（`/api/files/{id}`，`206`、強 ETag、`If-Range`），每個 Range 請求都會在 DB 定位 WorkFile 並 stat 檔案（kikoeru `docs/architecture.md`「Storage」）。
- 後端已用 `org.bytedeco:ffmpeg:8.1.2-1.5.14`（LGPL build、只有 `linux-x86_64`）在 JVM 內探測時長（kikoeru ADR-0001、`MediaProbe.java`）。native SIGSEGV 會直接結束 JVM，掃描用 `probe_guard` 標記 `PROBING`／`CRASHED` 避免重複 crash。

## 2. 字幕在容器中的位置

### 2.1 Matroska

- **Cluster**：影音字幕的 block 依時間交錯放在 Cluster 內。字幕通常用 BlockGroup，因為要帶 BlockDuration；RFC 9559 §5.1.3.5.3 提到 BlockDuration 適用於「there is a break in a track like for subtitle tracks」。
- **Cues**（RFC 9559 §5.1.5、§22）：每個 CuePoint 有 CueTime，以及一或多個 CueTrackPositions（CueTrack、CueClusterPosition，可選的 CueRelativePosition、CueDuration）。
  - CueClusterPosition 是 Cluster 在 Segment 中的位置。
  - CueRelativePosition 是 block 在 Cluster 內的相對位置（`minver: 4`）。
  - §22.1 Recommendations：「For each subtitle track present, each subtitle frame SHOULD be referenced by a CuePoint element with a CueDuration element.」也建議 block 不在 Cluster 第一個位置時寫 CueRelativePosition。
  - §6.4：Cues 若存在，SHOULD 放在第一個 Cluster 之前，或由 SeekHead 參照。
- 有了 CueClusterPosition + CueRelativePosition，就能直接算出每個字幕 block 的 byte offset；CueDuration 給出結束時間。也就是說，**光讀 Cues 就知道全部字幕在哪裡、何時開始與結束**，只差文字。
- **muxer 實際行為**：
  - FFmpeg `matroskaenc.c`（n7.1）：輸出可 seek 時，每個字幕 packet 都呼叫 `mkv_add_cuepoint()`（條件是 `codec_type == AVMEDIA_TYPE_SUBTITLE`），寫入 CueRelativePosition，有 duration 時寫 CueDuration。同一個時間點的多個字幕 event 也各自寫一筆（`has_cue` 檢查對字幕例外）。
  - mkvmerge 文件 `--cues`：「The default is 'iframes' for video and subtitle tracks and 'none' for audio tracks.」字幕 block 都是 I frame，所以每個字幕 block 都有 cue。
  - 實測（§3）兩者都是 792／792 個字幕 block 都在 Cues 中，而且都帶 CueRelativePosition 與 CueDuration。Cues 放在檔尾，由 SeekHead 參照。
- **例外**（未逐一驗證）：用 `--no-cues`／`--cues 2:none` 產生的檔案、直播錄製或沒有 seek 的寫入（FFmpeg 只在 `IS_SEEKABLE` 時寫 cue）、其他 muxer（MakeMKV、HandBrake 等）、CueRelativePosition 出現之前的舊檔。這些檔案只能整檔掃描。

### 2.2 ASS 在 Matroska 中的儲存方式

- draft-ietf-cellar-codec-16 §3.5.7 與 §6.3：`S_TEXT/ASS`，「Each event is stored in its own Block」。CodecPrivate 放 `[Script Info]` 與 Styles section；Block 內容依序是 `ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text`；Start／End 改由 Block timestamp 與 BlockDuration 表示。
  - 欄位是固定的 9 個，不跟 `Format:` 行走。kikoeru spike 的 `gen-subs.py` 也遇過這個陷阱（註解：「精簡欄位的 Format 包進 MKV 後，播放器照 Matroska 規格的固定欄位切 packet 會切不到文字」）。
  - draft 的 §3.5.7／§3.5.9 把 `[V4 Styles]`／`[V4+ Styles]` 寫反了，§6.3 的說法才正確。
- **實際的 CodecPrivate 比規格寫的多**。用含 `Comment:` 行與兩個非標準 section 的測試 ASS 分別經 FFmpeg 與 mkvmerge mux，兩份 CodecPrivate 的內容相同（mkvmerge 版多一個結尾換行，1,978 vs 1,976 bytes），都包含：
  - `[Script Info]`（含註解行 `; ...`）、`[Aegisub Project Garbage]`、`[V4+ Styles]`。
  - `[Events]` 與它的 `Format:` 行。
  - **全部 15 行 `Comment:`**（不會變成 Block）。
  - 放在原檔 `[Events]` 之後的 `[Aegisub Extradata]`。
  - 原檔的 UTF-8 BOM 被去掉，CRLF 保留。
- `[Fonts]`／`[Graphics]` 的 UUE 內嵌字型：規格寫可改用 Matroska Attachments（§3.5.7「MAY use embedded fonts from attachments」）。本次沒有測試含 `[Fonts]` 的 ASS。
- ContentEncoding：mkvmerge 文件提到「The default for some subtitle types is 'zlib' compression」。本次 ASS 軌沒有壓縮（mkvinfo 無 ContentEncodings），但自寫讀取器要能處理 zlib 與 header stripping（RFC 9559 §5.1.4.1.31）。

### 2.3 MP4（ISO BMFF）

- `moov/trak/mdia/minf/stbl` 的 `stco`／`co64`（chunk offset）、`stsc`（sample-to-chunk）、`stsz`（sample size）、`stts`（時間）可以算出**每個 sample 的 byte offset、大小與時間**。只要讀到 moov，就能只讀字幕 sample。
- FFmpeg `mov.c` 在 `mov_read_packet()` 中，`st->discard == AVDISCARD_ALL` 的軌不呼叫 `avio_seek`／不讀資料，只推進 sample index（n7.1 與 n9.0.2 相同）。所以用 libavformat discard 其他軌，就只會讀字幕 sample。
- fragmented MP4：每個 fragment 的 `moof/traf/trun` 各自描述 sample，要走過每一個 moof（實測 720 個 moof 共 802 KB，加 `mfra` 41 KB）。
- **ASS 放不進 MP4**：`ffmpeg -i test.ass -c:s copy -f mp4` 回「Could not find tag for codec ass in stream #0, codec not currently supported in container」。MP4 的文字字幕是 `mov_text`（tx3g）或 WebVTT（`wvtt`），從 ASS 轉過去會失去樣式、位置與 karaoke。kikoeru 的內嵌 ASS 實際上只會在 MKV（與 MKA）中出現。

## 3. 實測結果

測試媒體：640×360 H.264（CBR 5.5 Mbps，用 filler 把檔案撐到約 1 GB）+ AAC 192 kbps + 1 條 ASS，24 分鐘。ASS 有 792 個 Dialogue（每 2 秒一行，每 20 秒多一行重疊的看板字幕，一行刻意亂序）、15 個 Comment、karaoke tag、`\N`、`{\pos}`、兩個非標準 section，原檔為 UTF-8 BOM + CRLF。

| 檔案 | 大小 | Cluster | 字幕 block（皆為 BlockGroup） | 在 Cues 中（含 RelativePosition／Duration） | Cues 大小 |
|---|---|---|---|---|---|
| `ff.mkv`（FFmpeg 7.1 mux） | 1,018,364,683 | 720（平均 1.41 MB） | 792 | 792／792／792 | 30,838 |
| `mm.mkv`（mkvmerge v82.0） | 932,766,663 | 720（平均 1.30 MB） | 792 | 792／792／792 | 35,614 |
| `mm-offset.mkv`（字幕整體延後 1 秒，block 落在 cluster 中段） | 同上 | 720 | 792 | 792／792／792 | 同級 |

**MKV：各種讀法要讀多少 bytes**

| 讀法 | `ff.mkv` | `mm.mkv` | `mm-offset.mkv` | 請求數 |
|---|---|---|---|---|
| A. Cue 讀取器：EBML header～Tracks + Cues + 各字幕 block 本身 | **105,196**（header 2,575 + Cues 30,838 + blocks 71,783） | **113,946** | **114,741** | 1（header）+ 1（Cues）+ 720（block；同一處相鄰的 block 合併） |
| B. 用 libavformat 的 index（只有 cluster 位置），每個 cue seek 到 cluster 開頭再讀到字幕 block 為止 | 31,386,991 | 30,972,385 | **532,172,443**（57%） | 720 |
| C. libavformat 只取字幕軌，其他 discard（strace 量測 `read()`） | **1,018,266,379**（整檔，1 段連續讀取） | 932,694,484 | — | 整檔 |
| （參考）libavformat 開檔 + `find_stream_info` | 1,441,792 | — | — | — |

- B 的 `ff.mkv`／`mm.mkv` 數字偏低，是因為測試字幕剛好和 keyframe 對齊（每 2 秒），字幕 block 緊跟在 cluster 開頭的 keyframe 後面（平均相對位置 39 KB）。延後 1 秒後平均相對位置變成 672 KB，才比較接近真實檔案。
- A 的 block 讀取間隔約一個 cluster（1.3–1.4 MB），合併門檻放寬到 1 MB 也還是 720 次請求，因為沒有可以合併的相鄰讀取。
- C 用 strace 量測：只有 1 段連續讀取、沒有任何 seek，代表 discard 沒有讓 matroskadec 跳過任何 block。

**MP4：libavformat 只取字幕軌（strace）**

| 檔案 | moov／moof | 字幕 sample | libavformat 實際讀取 | 不連續的讀取段數 |
|---|---|---|---|---|
| faststart（moov 在前） | moov 1,499,971 | 1,440 個（含 mov_text 的空白間隔 sample），共 29,845 bytes | 25,093,317 | 720 |
| moov 在檔尾 | 同上 | 同上 | 25,125,699 | 722 |
| fragmented（`frag_keyframe+empty_moov`） | 720 個 moof 共 801,852 + mfra 41,136 | 794 個，28,553 bytes | 47,915,184 | 1,441 |

- 讀取量大於「moov + 字幕 sample」，是因為 file protocol 每次 seek 後都把 avio buffer（32 KiB）讀滿：720 × 32 KiB ≈ 23.6 MB。Engine 的 AVIO 若對這種 seek 只讀需要的大小，faststart 的下限約為 moov + 30 KB ≈ 1.5 MB（估算）。
- **另一個實測發現**：同樣的 MP4 改用 FFmpeg CLI 的 `http://` 讀取，HTTP Range server 記錄到**整個檔案都被送出**。原因是 HTTP protocol 的 short-seek 門檻預設取 TCP 接收視窗，間隔 1.4 MB 的 seek 被當成「往前讀比較划算」。這是 FFmpeg http protocol 的策略，不是 demuxer 的需求。Engine 自己的 AVIO 要明確決定多遠的 forward seek 改發新的 Range 請求。

**ASS 原文往返**（原檔 vs「mux → 取出」，比較非空白行）

| 路徑 | 行集合 | Dialogue 順序 | Comment 位置 | BOM／換行 |
|---|---|---|---|---|
| FFmpeg mux → `ffmpeg -copyts -c copy -f ass` | 828／828 完全相同 | 與原檔相同（亂序那行也還原） | 移到所有 Dialogue **之後**（屬於 CodecPrivate 的 trailer） | 無 BOM、LF |
| mkvmerge mux → `ffmpeg -copyts -c copy -f ass` | 相同 | 相同 | 同上 | 無 BOM、LF |
| FFmpeg mux → mkvextract | 相同 | 相同 | 移到所有 Dialogue **之前**（緊接 `Format:`） | 有 BOM、LF |
| mkvmerge mux → mkvextract | 相同 | 相同 | 同上 | 有 BOM、LF |

- 沒加 `-copyts` 時，FFmpeg CLI 輸出的時間全部晚 20 ms。原因是 CLI 會把輸入的 `start_time`（-0.021 s，來自 AAC 的 CodecDelay）平移到 0，不是 demuxer 的問題；直接用 libavformat API 拿到的 packet pts 不受影響（`ffprobe -show_packets` 第一個 packet 的 `pts=0`）。後端若用 CLI 或 muxer 重組，要注意這點。
- FFmpeg `assenc.c` 的作法是：extradata 中 `[Events]` 的 `Format:` 行之前當 header，之後的內容（Comment 行、`[Aegisub Extradata]`）當 trailer，寫在所有 Dialogue 之後；Dialogue 依 ReadOrder 重新排序。
- ASS 時間是百分之一秒，Matroska 的 TimestampScale 是 1 ms，往返沒有誤差。

## 4. 路線 A：Engine 內取出

### 4.1 A1：第二個 libavformat 實例，discard 其他軌

- **MP4**：可行，代價小（§3：數 MB、約 720 次 Range 請求，次數取決於字幕 sample 分布在幾個 chunk）。
- **MKV**：等於**把整個檔案下載一次**（1–2 GB）。原因是 `matroskadec.c` 的 `matroska_cluster_parsing` 把 SimpleBlock／Block 定義為 `EBML_BIN`，`ebml_read_binary()` 會 `avio_read` 整個 block，之後 `matroska_parse_block()` 才檢查 `st->discard >= AVDISCARD_ALL`。n7.1 與 n9.0.2 原始碼相同。
  - movi-player 0.4.1 的 `movi_prefetch_subtitle_cues()` 註解寫 discard「For matroska this triggers an avio_skip over the cluster body」，但它建置的 FFmpeg n9.0.2 原始碼與本次 strace 都不支持這個說法。它的註解也承認沒有 discard 時「seekbar's loaded indicator racing forward while playback sits paused for tens of seconds」。
- 第二個 demuxer 要用**另一個 AVFormatContext 與 AVIO**。若用 Asyncify build，同一個 wasm instance 也不能用：Emscripten Asyncify 文件寫「It is *not* safe to start an async operation while another is already running.」movi-player 的 prefetch 必須先停掉播放迴圈（原始碼註解提到不這樣做會出現「No pending read to fulfill」並卡住播放），就是這個限制。JSPI 或 SharedArrayBuffer + Atomics 的銜接方式是否有同樣限制，要看 #4（wasm 同步讀與非同步 fetch 的銜接方式）與 #17（libav.js 讀取中止與並行行為）的結論，本文未驗證。

### 4.2 A2：TS 寫的 Cue 讀取器（只適用 MKV）

流程：

1. 讀檔頭（EBML header、SeekHead、Info、Tracks，實測 2.6–6.5 KB）取得字幕軌的 TrackNumber、CodecID、CodecPrivate、ContentEncoding。
2. 依 SeekHead 讀 Cues（實測 31–36 KB，通常在檔尾，一次 Range）。播放用的 libavformat 開檔時也會讀這一段，可以共用 Range 快取。
3. 篩出 `CueTrack == 字幕軌` 的 CueTrackPositions，算出 `segmentStart + CueClusterPosition + clusterHeaderSize + CueRelativePosition`。
   - 「Cluster 的 header 長度」要讀 Cluster 的 ID 與 size 才知道（RFC 9559 §5.1.5.1.2.3 的「0 being the first possible position for an element inside that Cluster」）。實作時可以先讀一個小窗口再解析。
4. 每個位置讀一個小窗口（例如 1–4 KB；不足時再補讀），解析 BlockGroup／SimpleBlock，取出 Block payload 與 BlockDuration（沒有時用 CueDuration）。

代價（實測與外推）：

- bytes ≈ 檔頭 + Cues + Σ（字幕 block 大小 + 窗口浪費）。本例實際需要 105–115 KB；加上 720 × 4 KB 的窗口也只有約 3 MB。
- 請求數 ≈ 字幕 block 散布在幾個不相鄰的位置，上限是 event 數。外推到典型的 1–2 GB 影片（以下是估算）：

  | 情境 | event 數 | 需讀 bytes | Range 請求 |
  |---|---|---|---|
  | 24 分鐘動畫一集（1–1.5 GB） | 300–800 | 數十～約 150 KB | 數百 |
  | 2 小時電影（2 GB） | 1,000–2,000 | 約 200–400 KB | 1,000–2,000 |
  | 大量特效／karaoke 的 ASS | 5,000–20,000 | 1–3 MB | 上千～上萬；要以 cluster 為單位合併，代價是每段多讀夾在中間的影音資料 |

  每個 event 的成本約為 Cues 約 20–25 bytes（CueTrackPositions）加上 block（本例約 90 bytes，取決於文字長度）。
- 時間主要取決於請求次數與 RTT，不是頻寬。例如 720 次請求在 20 ms RTT 下，序列約 15 秒，4 條並行約 4 秒；LAN 約 1–3 秒（估算，未在瀏覽器實測）。每個請求在 kikoeru 後端都要做一次 DB 定位與 stat（kikoeru `architecture.md`）。HTTP/1.1 下瀏覽器對同一個 host 有連線數上限，要和播放的讀取分配連線。

必須處理的情況：

- Cues 不存在、沒有字幕軌的 entry、或缺 CueRelativePosition 時，改走 fallback（整檔掃描、交給後端，或只靠播放中的串流 cue）。這類檔案的比例未調查。
- RFC 9559 對 Cues 的要求只是 SHOULD，無法在不全檔掃描的情況下證明 Cues 完整。可以拿播放中串流得到的 cue 做去重與補漏。
- ContentEncoding：zlib 可以用瀏覽器的 `DecompressionStream('deflate')`（未驗證各瀏覽器支援）；header stripping 只需把前綴接回去。
- lacing：字幕通常不用 lacing（mkvmerge 寫 `"Lacing" flag: 0`），但讀取器要能拒絕或處理。
- 同一時間點的多個字幕 event 會各有一筆 CueTrackPositions（FFmpeg 實測），不要以 CueTime 去重。

### 4.3 取消、進度、與播放並行

| | A1（libavformat 全檔／MP4 sample） | A2（Cue 讀取器） |
|---|---|---|
| 取消 | AVIO read callback 接 AbortSignal（Engine 的 [必] 項目），中斷後回傳錯誤給 libavformat | 每個 fetch 直接帶 AbortSignal |
| 進度 | `avio_tell / fileSize`（MKV）或「已讀 sample／總 sample」（MP4，需自行從 index 取得） | 讀完 Cues 就知道總 cue 數，進度 = 已完成／總數，精確 |
| 與播放並行 | 需要另一個 AVFormatContext；Asyncify 下要另一個 wasm instance（記憶體與初始化成本另計） | 純 TS，不進 wasm，可在同一個 Worker 與播放並行 |
| 對播放的影響 | MKV 會和播放搶 1–2 GB 的頻寬 | 頻寬可忽略，但請求數多；可用較低優先序（`fetch` 的 `priority: 'low'`，瀏覽器支援度未驗證） |

### 4.4 Engine 中取得 ASS 原文

- libavformat 路徑：`codecpar->extradata` 就是 CodecPrivate 原文（實測 extradata 大小與 CodecPrivate 相同：1,976／1,978 bytes）。AVPacket 的 data 是 Block payload 原文（`ffprobe -show_data` 實測第一個 packet 為 `0,0,Default,話者A,0,0,0,,0秒目　{\k25}カ…`），`pts`／`duration` 是開始時間與長度。
- Cue 讀取器路徑：CodecPrivate 直接從 Tracks 讀；Block payload 與 libavformat 給的 packet data 相同（同樣的 9 個欄位）。
- 兩者可以輸出同一種資料形狀：`{ header: CodecPrivate 字串, events: [{ startMs, durationMs, raw }] }`。要還原成完整 `.ass`，就用 `startMs`／`durationMs` 補回 Start／End，並依 ReadOrder 排序。`Comment:` 行在 header 裡，不在 events 中。

## 5. 路線 B：後端用 bytedeco FFmpeg 抽出

### 5.1 成本

- bytedeco 只是 libavformat 的 JNI binding（`avformat_open_input`、`AVStream.discard`、`av_read_frame`、`codecpar().extradata()`，與 `MediaProbe.java` 用的 API 同一套），行為與 §3 的 C 版本相同：**MKV 讀整個檔案，MP4 只讀 moov 與字幕 sample**。不需要 javacv 的 `FFmpegFrameGrabber`，它以影音 frame 為中心，用不到。
- 讀整個 MKV 的時間取決於儲存媒體。本次只量到 tmpfs（page cache）上 1 GB 0.54 秒，代表 CPU 不是瓶頸。以常見的循序讀速度估算 1–2 GB（未實測）：

  | 儲存 | 循序讀 | 1–2 GB |
  |---|---|---|
  | HDD | 150–200 MB/s | 約 5–13 秒 |
  | SATA SSD | 約 500 MB/s | 約 2–4 秒 |
  | 1 GbE NAS（NFS） | 約 110 MB/s | 約 9–18 秒 |

- 後端也可以用同樣的 Cue 讀取器避免全檔掃描（Java 自寫 EBML 解析，本機 random read 很便宜）。代價是後端多一個 parser；kikoeru 的 Storage 若將來加入非本機實作（kikoeru `quarkus-range-streaming.md` 提到 S3），這個選項的價值會提高。

### 5.2 快取

- 結果很小（本例 ASS 原文約 85 KB），可以放在 `kikoeru.data-dir` 下（平台封面快取已有前例），key 用 `(WorkFile id, size, mtime, 軌道識別)`。size 與 mtime 就是現有強 ETag 的組成，檔案被換掉時自動失效。
- HTTP 層可以沿用強 ETag 與 `If-None-Match`。
- 抽取時機有兩種：
  - **掃描時預先抽**：讓每個新增或變更的 MKV 在掃描中多一次全檔讀取。掃描是單一 thread，會明顯拉長首次掃描。
  - **第一次請求時抽**：第一次請求要等數秒到十幾秒，要做 single-flight（同一檔案只抽一次）與全域併發上限，避免多人同時觸發多個 GB 級讀取。

### 5.3 API 形狀（草案，供 grilling）

```text
GET /api/files/{id}/subtitle-tracks            # 可選：列出內嵌字幕軌（或併入既有的 WorkFile 資訊）
GET /api/files/{id}/subtitle-tracks/{track}    # 取出整軌
  200 application/json
  {
    "codec": "ass",
    "header": "<CodecPrivate 原文>",
    "events": [ { "startMs": 0, "durationMs": 1500, "raw": "0,0,Default,話者A,0,0,0,,…" } ]
  }
  ETag: "<原檔 ETag>-<track>"
```

- 回傳「CodecPrivate + 原始 Block payload」而不是重組好的 `.ass`：和 Engine 從 demux 得到的資料形狀完全一致，App 只要一個 parser。也避開 FFmpeg ass muxer 在重組時搬動 Comment 位置、CLI 平移時間戳的問題。
- 若也要提供下載 `.ass`，可另外加 `Accept: text/x-ssa`，用 ass muxer 寫到記憶體（`avio_open_dyn_buf`）。
- **軌道識別要和 Engine 一致**：
  - libavformat 對 matroska 的 `AVStream.id` 是空的（ffprobe 顯示 `id=N/A`），所以不能直接拿 Matroska TrackNumber。
  - 若兩邊都用 libavformat，stream index 會依 Tracks 的順序排列，但兩邊的 FFmpeg 版本不同（後端 8.1.2，Engine 自行 build），一致性要測試。
  - 用 Matroska TrackNumber 最穩，但需要 Engine 從 libavformat 以外取得（例如 Cue 讀取器已經在解析 Tracks）。

### 5.4 風險

- **native crash 進入 request 路徑**：ADR-0001 已接受「FFmpeg 在 native 層的 crash（SIGSEGV）會直接結束 JVM」，並用 `probe_guard` 保護掃描。前台請求觸發抽取時，同一個檔案 crash 之後重啟，下一個請求還會再 crash 一次，需要類似的 guard（例如沿用 `(Library, path, size, mtime)`），或改在子 process 執行（image 裡目前沒有 ffmpeg CLI，ADR-0001 把 ffprobe CLI 列為備案）。
- **thread 模型**：抽取是阻塞的 native I/O，要放在 worker（`executeBlocking` 或專用 executor），並限制併發數。kikoeru 的規則是會阻塞的 I/O 在 transaction 結束後才執行（`architecture.md`「Storage」）。
- **重複讀檔**：使用者播放時，Engine 本來就會經 Range 讀到大部分的檔案；後端抽取又讀一次。在本機磁碟上影響不大，在 NAS 上會多一倍流量。

### 5.5 後端取得 ASS 原文

- 與 §4.4 相同：`codecpar().extradata()` 是 CodecPrivate，`AVPacket.data()` 是 Block payload，`pts`／`duration` 依 `time_base` 換算成毫秒。直接用 libavformat API，不經 CLI，就沒有 `start_time` 平移的問題。

## 6. 比較

| | A1 Engine + libavformat | A2 Engine Cue 讀取器 | B 後端 bytedeco |
|---|---|---|---|
| MKV 讀取量（1–2 GB） | 整個檔案（經網路） | 約 0.1–0.4 MB（典型），數百～數千次 Range | 整個檔案（本機磁碟），或後端也做 Cue 讀取 |
| MP4 讀取量 | moov + 字幕 sample（數 MB 以內） | 不適用（交給 A1） | 同 A1，但在本機 |
| 沒有字幕 Cues 的 MKV | 一樣是整檔 | 必須 fallback | 一樣可用 |
| ASS header／event 原文 | extradata + packet data | CodecPrivate + Block payload | extradata + packet data |
| 取消 | AbortSignal → AVIO | AbortSignal → fetch | 要另外設計（取消請求不一定能中止 native 迴圈） |
| 進度 | byte 位置 | 精確的 cue 計數 | HTTP 請求只有完成與否；要進度得改成 job + 輪詢 |
| 與播放並行 | 要另一個 context／instance；MKV 會搶頻寬 | 可以，負擔小 | 不影響 Engine |
| 新增的程式 | 少（重用 Engine 的 demux） | TS EBML 解析（SeekHead、Tracks、Cues、BlockGroup、ContentEncoding） | endpoint、快取、guard、併發控制 |
| 主要風險 | MKV 實際上不可用 | Cues 不完整或缺失時要 fallback；請求數多 | native crash 進入 request 路徑；第一次等待數秒 |
| 依賴 kikoeru 後端改動 | 否 | 否 | 是（新的 API 與 ADR） |

## 7. 給 grilling 的輸入

- 「MKV 用 libavformat 只讀字幕」這條路不存在：只要用 libavformat 取 MKV 整軌，就是讀整個檔案，不論在 Engine 還是後端。
- Engine 內可行的形式只有「MP4 用 libavformat，MKV 用自寫的 Cue 讀取器」，加上 Cues 不足時的 fallback 策略。
- 後端的形式是「每個 (檔案, 軌) 讀一次整檔後快取」。主要決策點在抽取時機（掃描時或第一次請求時）、crash guard、API 與 Engine 的資料形狀是否一致、軌道識別。
- 兩者不互斥：例如 Engine 先試 Cue 讀取器，不行時才呼叫後端，或只靠播放中的串流 cue。但這會讓 Engine 依賴 kikoeru 的 API，而 Engine 是獨立套件，可能需要以「整軌字幕來源」介面注入。

## 未驗證／限制

- 測試檔是合成的：只有一條字幕軌，event 間隔固定，cluster 也是固定 2 秒。真實檔案的 cluster 大小、字幕 block 分布、Cues 寫法（特別是 MakeMKV、HandBrake、舊版 mkvmerge 或其他 muxer）沒有調查；「多少比例的 MKV 有完整的字幕 Cues」是未知數。
- Engine 端的請求次數與時間是推算；沒有在瀏覽器量測 720 次 Range 請求的實際耗時、HTTP/1.1 連線上限的影響，也沒有量測 kikoeru 後端每個 Range 請求的成本。
- 後端的讀檔時間只在 tmpfs 實測；HDD、SSD、NAS 的數字是用常見循序讀速度估算。
- bytedeco 8.1.2 的行為是依 FFmpeg 7.1 實測與 n7.1／n9.0.2 原始碼推論，沒有直接在 JVM 中執行。
- 沒有測試：含 `[Fonts]` 的 ASS、ContentEncoding（zlib／header stripping）的字幕軌、SSA（`S_TEXT/SSA`）、WebVTT／SRT 內嵌軌、MKV 中有多條字幕軌的情況、`DecompressionStream` 與 `fetch` `priority` 的瀏覽器支援度。
- Asyncify 的限制來自 Emscripten 文件；JSPI 或 SharedArrayBuffer + Atomics 是否允許同一個 instance 內兩個 demux 並行沒有驗證。

## 來源

- RFC 9559, Matroska Media Container Format Specification：§5.1.3（Cluster、SimpleBlock、BlockGroup、BlockDuration）、§5.1.5（Cues 各元素）、§6.4、§22（Cues 與 §22.1 Recommendations）。<https://www.rfc-editor.org/rfc/rfc9559>
- draft-ietf-cellar-codec-16（2025-11-09），Matroska Media Container Codec Specifications：§3.5.7 `S_TEXT/ASS`、§3.5.9 `S_TEXT/SSA`、§6.3 SSA/ASS Subtitles、§6.4 WebVTT。<https://datatracker.ietf.org/doc/draft-ietf-cellar-codec/>
- FFmpeg 原始碼（tag `n7.1`，部分對照 `n9.0.2`）：
  - `libavformat/matroskadec.c`：`matroska_cluster_parsing`、`ebml_read_binary()`、`matroska_parse_block()` 的 discard 檢查、`matroska_add_index_entries()`、`MATROSKA_ID_CUERELATIVEPOSITION` 為 `EBML_NONE`。
  - `libavformat/matroskaenc.c`：`mkv_add_cuepoint()`、字幕 packet 的 cue 條件、Cues 寫入時對字幕的例外。
  - `libavformat/mov.c`：`mov_find_next_sample()`、`mov_read_packet()` 的 discard 處理。
  - `libavformat/assenc.c`：header／trailer 切分、ReadOrder 排序；`libavformat/assdec.c`。
  - `libavformat/movenc.c`：MP4 字幕 codec tag 只有 `mov_text`。
  - <https://github.com/FFmpeg/FFmpeg>
- mkvmerge 文件（MKVToolNix v82.0）：`--cues`、`--no-cues`、`--compression`。<https://mkvtoolnix.download/doc/mkvmerge.html>
- Emscripten Asyncify 文件，「Reentrancy」節。<https://emscripten.org/docs/porting/asyncify.html>
- movi-player 0.4.1：`wasm/movi_decode.c` 的 `movi_prefetch_subtitle_cues()`、`src/core/MoviPlayer.ts` 的 `getAllSubtitleCues()`／`prefetchActiveSubtitleStream()`、`docker/Dockerfile`（`FFMPEG_VERSION=n9.0.2`）。<https://github.com/MrUjjwalG/movi-player>
- kikoeru（本機 clone）：`docs/adr/0001-bytedeco-ffmpeg-for-media-probing.md`、`src/main/java/x/kikoeru/library/infrastructure/media/MediaProbe.java`、`pom.xml`（`ffmpeg.version` 8.1.2-1.5.14）、`docs/architecture.md`（Storage、掃描、probe guard）、`docs/research/frontend-subtitle-handling.md`、`docs/research/movi-player-capability.md`、`docs/research/quarkus-range-streaming.md`、`docs/api/openapi.yaml`（`/api/files/{id}`）、`src/main/webui-player-spike/media/gen-subs.py`。

## 附錄：實測方法

1. 用 Python 產生測試 ASS（內容見 §3），再用 FFmpeg 7.1 產生 `ff.mkv`（libx264 CBR 5.5 Mbps、`-g 60`，ASS 以 `-c:s copy` mux），並轉成三種 MP4（`+faststart`、moov 在尾、`frag_keyframe+empty_moov+default_base_moof`，字幕轉為 `mov_text`）。用 mkvmerge v82.0 由 `ff.mkv` 的影音加原始 `.ass` 產生 `mm.mkv`，再用 `--sync 0:1000` 產生 `mm-offset.mkv`。
2. 自寫 EBML 掃描器：解析 SeekHead 之外的 top-level element、Tracks（CodecPrivate）、Cues（逐筆 CueTrackPositions）。再全檔走訪每個 Cluster 的 SimpleBlock／BlockGroup，找出所有字幕 block 的位置與大小，比對是否都被 Cues 涵蓋，並計算 §3 的 A、B 讀取量。
3. 在容器內以 `strace -f -e trace=openat,read,lseek,close` 執行 `ffmpeg -i <檔案> -map 0:s:0 -c copy -f ass`（MP4 則 `-c:s srt`），統計輸入檔 fd 的 `read()` 總量與不連續的讀取段數。
4. 另以自寫的 HTTP Range server 讓 FFmpeg 經 `http://` 讀取，觀察 http protocol 的 short-seek 行為（§3 的另一個實測發現）。
5. ASS 往返：比較原檔與 `ffmpeg -copyts -c copy -f ass`、`mkvextract tracks` 輸出的非空白行集合、Dialogue 順序、BOM 與換行。
