# AudioDecoder 的取樣精準度、背景回收與效益

> Research ticket：[#18](https://github.com/mocukie/kikoeru-player/issues/18)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)；下游決策：[#19 音訊解碼路線的選擇規則](https://github.com/mocukie/kikoeru-player/issues/19)）
> 實測日期：2026-10-13。前提見 [ADR-0003](../adr/0003-decode-paths.md)：media Worker 內同時有 wasm（libav.js `kikoeru-af`）與 `AudioDecoder` 兩條音訊解碼路線，兩者都以 fltp 進同一個 filter graph。
> 標記：**[實測]** 本次在瀏覽器量到；**[原始碼]** 對照 Chromium／Gecko／WebKit／FFmpeg 原始碼；**[推論]** 由前兩者推得；**[未測]** 本次無法測（主要是 Apple Safari 與手機）。

## 結論先講

1. **`AudioDecoder` 輸出的是 decoder 的「原始」輸出，什麼都不裁** [實測，三家]。AAC 的 priming（FFmpeg encoder 1024、fdk-aac 2048）、MP3 的 encoder delay + decoder delay（LAME：576 + 529 = 1105）、結尾的 padding（MP4 edit list、LAME header、Ogg granule、WebM DiscardPadding）全部原樣輸出。對齊之後，與 FFmpeg 未裁切的輸出幾乎逐 sample 相同（max abs diff：AAC、Vorbis、Opus 在 Chromium／Firefox ≤ 2.4e-7，WebKit 的 Opus 1.5e-5；MP3 ≤ 1.1e-6，Firefox 的 MP3 4.4e-5；FLAC 完全相同）。**唯一的例外是 Opus**：Chromium 與 Firefox 在給了 `description`（OpusHead）時會裁掉 pre-skip，WebKit（Linux／GStreamer）不裁。
2. **Engine 走 `AudioDecoder` 時要自己做 FFmpeg 在 wasm 路線自動做的事**。裁切資訊 libav.js 不用 patch 就拿得到：每個封包的 `side_data` 裡的 `AV_PKT_DATA_SKIP_SAMPLES`（type 11，le32 start、le32 end）。開頭的裁切在第一個封包（MP4 另外把整個 priming 封包標成 `AV_PKT_FLAG_DISCARD`），結尾的裁切在最後一個封包。`codecpar` 的 `initial_padding`、`seek_preroll` 需要加 accessor（[`codecpar-accessors.patch`](../../research/audiodecoder-spike/codecpar-accessors.patch)，10 行），但只靠 side data 也能做出正確的裁切。ADTS 與沒有 LAME header 的 MP3 沒有任何裁切資訊，FFmpeg 自己也會多出 priming，兩條路線結果一樣。
3. **`AudioData.timestamp` 不可信，而且三家各錯各的** [實測]：
   - 負的 timestamp（MP4 edit list、Ogg Opus 的 pre-skip 都會讓第一個封包 pts < 0）：Chromium 把第一個輸出改成 0、之後依 sample 數連續往後排，**整條時間軸往後移 21.3 ms**；Firefox 照抄；**WebKit 輸出的 timestamp 是 −20 秒、內容整段錯亂**。所以 Engine 送進去的 timestamp 一定要 ≥ 0。
   - Opus 帶 `description` 時，Chromium 與 Firefox **在每次 `configure()`／`reset()` 之後都重裁一次 pre-skip（312 sample），但 timestamp 不跟著調**，每次 seek 後擺放都差 6.5 ms。
   - Vorbis 在 reset 之後的第一個封包沒有輸出：Firefox 送出 0 frame 的 `AudioData`，下一個輸出的 timestamp 正確；Chromium 把第一個真正的輸出標成第一個 chunk 的 timestamp，**差了 896 sample（18.7 ms）**。
4. **seek 要往前多送的封包數，兩條路線一樣**，由 codec 本身決定 [實測]：AAC 1 個（之後完全相同）；MP3 2 個（bit reservoir）；FLAC 0 個；Vorbis 1 個（這個封包不會有輸出）；Opus 收斂得慢，80 ms（4 個封包）時目標處的峰值誤差仍有 0.05，160 ms 是 0.0033，240 ms 是 0.00024。wasm 路線用 `avcodec_flush_buffers` 不會重裁；`AudioDecoder` 每次 reset 的行為見上一點。
5. **背景回收不會影響本 Engine 用到的音訊 codec** [原始碼＋實測]。Chromium 只對 `IsPlatformDecoder()` 為 true 的 decoder 施加 codec pressure。AAC-LC／HE-AAC、MP3、Opus、Vorbis、FLAC、PCM 在所有平台（含 Android）都用 renderer 內的軟體 decoder（FFmpeg／Symphonia／libopus），CDP 的 media log 也顯示 `kIsPlatformAudioDecoder=false`。會走 platform decoder 的只有 xHE-AAC（Android 9+、Mac、Win 的 MediaCodec／AudioToolbox／MF）與 Mac／Win 的 AC-3／E-AC-3、Win 的 AC-4。即使是 platform decoder，也要背景中閒置 90 秒才會被回收，持續解碼中不會。Firefox 與 WebKit 的 WebCodecs 沒有回收邏輯。
6. **效益：桌面上 `AudioDecoder` 路線反而比較耗 CPU** [實測，AMD EPYC，headless]。以「解碼 → fltp → atempo 1.25」的完整路徑計算，48k 的 MP3／AAC／Opus／Vorbis：Chromium 多 43–56%，WebKit 多 33–46%，**Firefox 多 118–179%**。FLAC 48k 差不多（Chromium +6%），只有 FLAC 192k／24-bit 在 Chromium 便宜 6%。原因是 wasm 的解碼本身就很便宜（48k 2.1–4.5 ms／媒體秒），`AudioData` 的格式轉換、複製進 wasm 與跨執行緒的成本超過省下的部分。兩條路線的大頭都是 filter graph（atempo 1.25 約 4–17 ms／媒體秒）。手機的 CPU 與電量 **[未測]**。
7. **`isConfigSupported` 擋不住實際的失敗** [實測]：
   - **Chromium 153：`pcm-s24` 解出的 `AudioData` 呼叫 `copyTo()`／`allocationSize()` 會讓 renderer crash**（整個分頁掛掉，不是 error callback）。已做出 10 行的最小重現。
   - **Firefox 155：`pcm-s24` 只輸出 75% 的 sample**，不報錯。
   - WebKit（Linux／GStreamer，不代表 Safari）：FLAC 全部 `EncodingError`；Vorbis 與 6 聲道 Opus 沒有輸出、`flush()` 永遠不 resolve，而且之後同一個 process 的 `isConfigSupported` 也不再回應。
   - 三家都回報支援，實際也能解的：AAC-LC（含 6ch、96k）、MP3（含 8k／22.05k mono）、Opus ≤ 2ch。Chromium 與 Firefox 的 FLAC（到 384k）、Vorbis（含 6ch）也可以。ALAC、WavPack、AC-3、E-AC-3、xHE-AAC 在 Linux 上三家都回報不支援。

**對 #19 的含意（摘要，詳見最後一節）**：在桌面上，`AudioDecoder` 路線在精準度、CPU、可靠性三方面都沒有贏過 wasm，還要多維護一張「瀏覽器 × codec」的怪癖表。唯一可能翻盤的地方是手機的 CPU 與電量，需要實機數字。

---

## 0. 環境與方法

- **wasm**：libav.js `v6.10.9.0`（FFmpeg 9.0）的 `kikoeru-af` variant。build 方式沿用 [#10](https://github.com/mocukie/kikoeru-player/issues/10) 的 `research/build-spike`，依序打三個 patch：#10 的 `libavjs-accessors.patch`、#17 的 `avio-accessors.patch`，以及本次的 `codecpar-accessors.patch`（`AVCodecParameters` 的 `initial_padding`、`trailing_padding`、`seek_preroll`、`frame_size`、`block_align`、`bits_per_*`）。wasm 1947.7 KiB raw／630.4 KiB brotli，與 #10 的數字相同。libav.js 在 module Worker 內以 `noworker` 載入，檔案整個放進 MEMFS（本次不測 I/O）。
- **瀏覽器**：官方 Docker image `mcr.microsoft.com/playwright:v1.63.0-noble` 內的 Chromium 153.0.8010.12（headless shell）、Firefox 155.0、WebKit 26.6（Linux 版，音訊 decoder 走 GStreamer 1.24 與 gst-libav／FFmpeg 6.1）。全部 headless、沒有 GPU。機器是 AMD EPYC 7K62，32 vCPU。
- **要特別注意的差異**：
  - **Linux 的 WebKit 不等於 Apple Safari**。Safari 的 `AudioDecoder` 走 AudioToolbox（`AudioDecoderCocoa` 加 `AudioSampleBufferConverter`），GStreamer 的 bug 與行為不能套用到 Safari。
  - **Firefox 在 Linux 上的 AAC 用系統的 libavcodec**（image 內是 FFmpeg 6.1）。Windows 是 WMF、macOS 是 AudioToolbox，priming 與時間戳的行為可能不同。
  - headless Chromium 的 codec 與 Chrome 正式版一致（#5 已驗證 AAC 可用），但 Linux 沒有任何 platform audio decoder。
- **媒體**（[`gen-media.sh`](../../research/audiodecoder-spike/gen-media.sh)，Docker 內的 ffmpeg 7.1，媒體不進 git）：
  - 對齊用訊號：左右聲道不同、頻率緩慢調變的正弦（都在 4 kHz 以下），加上固定 seed 的雜訊。長度 20.0123 秒，刻意不是任何 frame 長度的整數倍。
  - 準確度：AAC（FFmpeg aac 與 libfdk_aac 的 MP4、ADTS）、MP3（libmp3lame，有／無 Xing+LAME header，44.1k）、Opus（Ogg、WebM）、FLAC、Vorbis（Ogg、WebM），48k stereo。
  - **基準（truth）**：同一訊號的 FLAC（無失真、沒有 delay）經 FFmpeg 解碼。
  - CPU：48k 300 秒的 MP3（192k）、AAC（192k）、Opus（128k）、Vorbis（q5）、FLAC（24-bit），以及 192k／24-bit 60 秒的 FLAC 與 WAV（s24）。
  - `isConfigSupported`：3 秒的 AAC 6ch／96k、Opus 6ch、FLAC 6ch／192k／384k、Vorbis 6ch、MP3 8k／22.05k mono、ALAC、PCM s24 96k／f32。
- **harness**（[`research/audiodecoder-spike/`](../../research/audiodecoder-spike/)）：沿用 #17 的 Playwright runner、Range server 與 Worker 架構，另外：
  - `audio.mjs`：demux、wasm 解碼（`ff_decode_filter_multi`，預設 filter 只轉 fltp）、`AudioDecoder` 解碼（`copyTo({format: "f32-planar"})`，不支援時自己轉）、cross-correlation 對齊與差異計算。
  - lag 的定義：輸出比 truth 多出的前導 sample 數，用第 3 秒起 4096 sample 視窗的正規化相關找出。max abs diff 是對齊後全段的最大絕對差。
  - CPU：runner 從 `/proc` 加總**所有瀏覽器 process** 的 utime+stime。`AudioDecoder` 可能在別的執行緒或 process 解碼，這樣才算得進去。
  - Chromium 的 decoder 名稱與 `kIsPlatformAudioDecoder` 用 CDP 的 `Media` domain 取得。
  - WebKit 的某些 decoder 會卡住整個 process，所以 WebKit 的測試每個檔案各開一個 browser context。
- 原始數據在 [`research/audiodecoder-spike/data/`](../../research/audiodecoder-spike/data/)。

## 1. 取樣精準度

### 1.1 各 codec 的輸出與 FFmpeg 的比較

表中的「前導」是輸出比 truth 多出的前導 sample，「長度差」是輸出總長減去 truth（960590；MP3 為 44.1k 的 882542）。WebKit 的 MP4 與 Opus 用「所有 timestamp +1 秒」的結果（負 timestamp 會錯亂，見 1.3）。

| 檔案 | libavformat 給的裁切資訊（skip side data：start/end；`initial_padding`） | FFmpeg（wasm，自動裁切）前導／長度差 | AudioDecoder 前導／長度差（Chromium＝Firefox＝WebKit，除非另註） | 與 FFmpeg 未裁切輸出的 max abs diff（Cr／Fx／WK） |
|---|---|---|---|---|
| `acc-aac.m4a`（FFmpeg aac） | 第一個封包 1024/0 且帶 `AV_PKT_FLAG_DISCARD`；最後一個封包 0/960；`initial_padding` 1024 | 0／−14 ¹ | 1024／+1970 | 1.5e-7／1.5e-7／1.5e-7 |
| `acc-fdk.m4a`（libfdk_aac） | 第一個封包 2048/0，前兩個封包帶 DISCARD；最後 0/960；`initial_padding` 2048 | 0／−14 ¹ | 2048／+2994 | 1.8e-7／1.8e-7／1.8e-7 |
| `acc-aac.aac`（ADTS） | 無 | 1024／+1970 | 1024／+1970 | 1.5e-7／1.5e-7／1.5e-7 |
| `acc-mp3.mp3`（LAME header） | 第一個封包 1105/0，最後一個 0/1089；`initial_padding` 0 | 0／0 | 1105／+2194 | 9.2e-7／**4.4e-5**／1.0e-6 |
| `acc-mp3-noxing.mp3` | 無 | 1105／+2194 | 1105／+2194 | 同上 |
| `acc-opus.opus`（Ogg） | 第一個封包 312/0（pre-skip），最後 0/58（granule）；`initial_padding` 312、`seek_preroll` 3840 | 0／0 | 帶 description：Cr、Fx **0／+58**（自己裁掉 pre-skip），WK 312／+370。不帶：三家 312／+370 | 2.1e-7／1.8e-7／1.5e-5 |
| `acc-opus.webm` | 第一個封包 312/0（CodecDelay），最後 0/58（DiscardPadding）；`initial_padding` 312 | 0／0 | 同 Ogg | 同上 |
| `acc-flac.flac` | 無 | 0／0 | Cr、Fx 0／0；**WK `EncodingError`** | 0／0／— |
| `acc-vorbis.ogg` | 最後一個封包 0/50（granule） | 0／0 | Cr、Fx 0／+50；**WK 沒有輸出、`flush()` 不回應** | 2.1e-7／2.4e-7／— |
| `acc-vorbis.webm` | 無（WebM 的 Vorbis 沒有結尾資訊） | 0／+50 | Cr、Fx 0／+50 | 同上 |

¹ FFmpeg 的 aac encoder 寫進 MP4 的 edit list 長度本身少了 14 sample，這是 muxer 那一端的問題，與解碼無關。`AudioDecoder` 照 side data 裁完後，結果與 FFmpeg 完全相同（結尾 +946 = 960 − 14）。

重點 [實測]：

- **`AudioDecoder` 的輸出就是 decoder 的原始輸出**，跟 FFmpeg 在「拿掉 side data、拿掉 `initial_padding`、忽略 DISCARD 旗標」時的輸出一致。Chromium 的 AAC、Vorbis、PCM 走 FFmpegAudioDecoder，MP3 與 FLAC 走 SymphoniaAudioDecoder（Rust），Opus 走 OpusAudioDecoder（libopus），結果都與 wasm 的 FFmpeg 9.0 差在 1e-6 以內。Firefox 的 MP3 差 4.4e-5（約 −87 dB），可能是 decoder 實作不同，聽不出來。
- **Opus 是唯一會被瀏覽器自己裁的**。Chromium 是在 `OpusAudioDecoder` 從 OpusHead 讀 pre-skip（`codec_delay_ = extra_data->skip_samples`），並在 `ResetTimestampState()` 裡交給 `AudioDiscardHelper` 裁 [原始碼]。WebCodecs 建 config 時把 `codec_delay` 設成 0，但 Opus decoder 不看它。WebKit 的 Cocoa 版本也會從 description 解析 `preSkip` 交給 converter（`AudioDecoderCocoa.cpp` L275–277），**Safari 很可能也會裁**，需要實機確認 [原始碼，未測]。
- 結尾的 padding 三家都不裁。`EncodedAudioChunk` 沒有 discard padding 的欄位，規格上也沒有裁切的機制。

### 1.2 Engine 要自己裁什麼、資訊從哪裡來

**libavformat 的來源** [原始碼，FFmpeg 9.0]：

- 開頭：各 demuxer 把要裁的 sample 數放進 `FFStream.skip_samples`（MP4：edit list，`mov.c` L4546–4580；MP3：LAME header 的 `start_pad + 529`，存在 `start_skip_samples`，`mp3dec.c` L262；Matroska：CodecDelay，`matroskadec.c` L2897–2901；Ogg Opus：pre-skip）。`demux.c` L1545–1556 再把它寫成第一個封包的 `AV_PKT_DATA_SKIP_SAMPLES`。
- 結尾：`first_discard_sample`／`last_discard_sample`（MP3 的 LAME padding、MP4 的 iTunSMPB）由 `demux.c` L1536–1543 換成最後一個封包的 skip end。Matroska 的 DiscardPadding、Ogg 的 granule 由各自的 demuxer 直接寫成 side data。
- `codecpar->initial_padding`：MP4（`mov.c` L4666）、Matroska、Ogg Opus（`oggparseopus.c` L62）會設，**MP3 不會設**（只走 side data）。`seek_preroll`：Opus 為 3840（48k 下 80 ms）。
- seek 回開頭附近時，demuxer 會重新附上 skip：MP3 在 `pts == 0` 時用 `start_skip_samples` 重設（`demux.c` L1545），MP4 在 seek 時用 `mov_get_skip_samples()` 依 `initial_padding` 重算（`mov.c` L12041–12090）。
- MP4 會把整個落在 edit list 之前的封包標成 `AV_PKT_FLAG_DISCARD`（實測 `flags = 5`）。FFmpeg 的 decoder 會丟掉這些封包的輸出，並從 `skip_samples` 扣掉相同的數量（`decode.c` L358），所以總共只裁 1024／2048，不會重複計算。

**libav.js 拿得到什麼** [原始碼＋實測]：

- `ff_read_frame_multi` 回傳的封包物件本來就有 `side_data`（`p-avfcbridge.in.js` 的 `ff_copyout_side_data`）與 `flags`，**不用 patch**。
- `codecpar` 的 `initial_padding`、`trailing_padding`、`seek_preroll` 在 libav.js 6.10.9.0 沒有 accessor（`ff_copyout_codecpar` 也沒帶），要打 `codecpar-accessors.patch`。`AVStream` 內部的 `skip_samples` 屬於 `FFStream`，不是公開 API，拿不到也不需要。

**AudioDecoder 路線的裁切規則**（[推論]，與 FFmpeg 的 `decode.c` 等價）：

1. 開頭：解碼後從輸出開頭丟掉「第一個封包 skip start」個 sample。帶 DISCARD 旗標的封包**照樣要送進 decoder**（需要它暖機），它們的輸出算在 skip start 裡面。
2. 結尾：丟掉最後一個封包輸出的最後「skip end」個 sample。
3. 例外：Chromium／Firefox 的 Opus 帶 description 時，瀏覽器已經裁過 pre-skip，Engine 不能再裁一次。這個行為因瀏覽器而異（WebKit 不裁），最簡單的做法是 **≤ 2 聲道的 Opus 不給 description**（Chromium 與 Firefox 都接受），讓三家都輸出原始資料，由 Engine 依 side data 裁。多聲道 Opus 必須帶 description（Chromium 的 `isConfigSupported` 直接丟 `TypeError`），WebKit Cocoa 不支援 > 2 聲道（`AudioDecoderCocoa.cpp` L249–250）。
4. 沒有任何資訊的檔案（ADTS、沒有 LAME header 的 MP3、WebM 的 Vorbis）兩條路線都一樣多出 priming 或 padding，不必特別處理。

wasm 路線上，上面這些都由 FFmpeg 自動完成：開 decoder 時 `avcodec_parameters_to_context` 把 `initial_padding` 設成 `avctx->delay`，`avcodec_open2` 再設 `skip_samples = delay`（`avcodec.c` L365）；Opus decoder 會自己從 OpusHead 讀 pre-skip。`avcodec_flush_buffers` **不會**重設 `skip_samples`，所以 seek 後不會重裁。要注意的是，**seek 時不能為了重設狀態而關掉 decoder 再開**，否則會把 `initial_padding` 再裁一次。

### 1.3 timestamp

以「每個 chunk 的 timestamp ＝ 封包 pts 換成 µs」送入，觀察輸出的 `AudioData.timestamp` [實測]：

| 情況 | Chromium 153 | Firefox 155 | WebKit 26.6（GStreamer） |
|---|---|---|---|
| 第一個 chunk 為負（MP4 −21333 µs、Ogg Opus −6500 µs） | 第一個輸出改成 **0**，之後依 sample 數連續，**整條時間軸往後移 21.3 ms** | 照抄 −21333 | 第一個輸出約 **−20 秒**，輸出內容錯亂（與 truth 對不上，SNR −3 dB） |
| 全部 +1 秒（沒有負值） | 照抄 | 照抄 | 照抄，輸出正確 |
| Opus 帶 description | 開頭少 312 sample，timestamp **不調整**；**每次 reset／configure 都重裁** | 同 Chromium，另外輸出之間有一次 6.5 ms 的跳動 | 不裁 |
| Vorbis reset 後的第一個封包 | 沒有輸出；下一個輸出被標成**第一個** chunk 的 timestamp（差 896 sample） | 送出 0 frame 的 `AudioData`；下一個輸出的 timestamp 正確 | 沒有輸出就卡住 |
| WebM（timestamp 只到 ms） | 與 sample 位置差最多 48 sample（容器精度） | 同 | 同 |

**做法上的含意** [推論]：

- Engine 要用自己的時間軸（例如 sample 為單位，加上偏移保證 ≥ 0）產生 chunk timestamp。
- 輸出的位置用「第一個送入封包的位置 ＋ 累計 sample 數」計算，不讀 `AudioData.timestamp`。
- 但累計 sample 數本身也受上表的怪癖影響（Opus 重裁、Vorbis 首包無輸出、0 frame 的 `AudioData`），只能靠一張「瀏覽器 × codec」的修正表。wasm 路線沒有這些問題。

### 1.4 seek：要往前送幾個封包

做法：目標 10 秒。從目標封包往前 k 個封包開始送，`AudioDecoder` 每次用新的 decoder（等同 `reset()` + `configure()`），wasm 則對同一個 decoder 做 `avcodec_flush_buffers`。再用 cross-correlation 對齊到各自的連續解碼，比較目標之後 2048 sample 的 max abs diff。所有 timestamp 都 +1 秒。訊號峰值約 0.5 [實測]。

| codec | k=0 | k=1 | k=2 | k=3 | k=4 | k=6 | k=8 | k=12 | 結論 |
|---|---|---|---|---|---|---|---|---|---|
| AAC（MP4、ADTS） | 0.44–0.48 | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 往前 1 個 frame（MDCT overlap） |
| MP3 | 0.456 | 0.447 | **0**（Fx 3e-5） | 0 | 0 | 0 | 0 | 0 | 往前 2 個 frame（bit reservoir 加 overlap） |
| Opus（20 ms 封包） | 0.417 | 0.311 | 0.188 | 0.098 | 0.051 | 0.014 | 0.0033 | 0.00024 | 持續收斂、不會完全一致；80 ms 時峰值誤差仍約 −20 dB |
| FLAC | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不需要 |
| Vorbis | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 第一個封包本來就沒有輸出，等於往前 1 個封包 |

- 三家瀏覽器的 `AudioDecoder` 與 wasm 的數字幾乎相同，差異來自 codec 本身，與路線無關。WebKit 的 FLAC、Vorbis 解不出來，沒有數字。
- Opus 依 RFC 7845 §4.6 的建議至少往前 80 ms（`seek_preroll` 3840）。以相對訊號峰值計算，本次的訊號在 80 ms 時峰值誤差約 −20 dB，160 ms 約 −44 dB，240 ms 約 −66 dB。這是 CELT 的狀態收斂本身的特性，wasm 也一樣。Engine 是否要多送一些，可以在實作時用聽感決定。

**`AudioDecoder` 路線的 seek 程序** [推論]：

1. demuxer seek 到「目標 − preroll」之前的封包（`AVSEEK_FLAG_BACKWARD`）。preroll：AAC 1 個 frame、MP3 ≥ 2 個 frame（保險起見 3–4 個）、Opus 用 `seek_preroll`（80 ms）或更多、Vorbis 1 個封包、FLAC／PCM 0。
2. `reset()` + `configure()`。Opus 不帶 description（≤ 2ch）。
3. 送封包時，timestamp 用 Engine 自己的、≥ 0 的時間軸。
4. 依「第一個送入封包的位置 ＋ 累計 sample 數 ＋ 修正表」算出每個 sample 的位置，丟到目標 sample 為止。如果 seek 落在檔頭附近，還要套用第一個封包的 skip start。

wasm 路線同樣是第 1 步加 `avcodec_flush_buffers`，再依輸出 frame 的 pts 丟到目標，裁切由 FFmpeg 處理。

## 2. 背景回收

### 2.1 Chromium

[原始碼，Chromium main，2026-10]：

- `DecoderTemplate::OnInitializeDone` 只在 `decoder()->IsPlatformDecoder()` 為 true 時 `ApplyCodecPressure()`，否則 `ReleaseCodecPressure()`（[`decoder_template.cc` L706–709](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/webcodecs/decoder_template.cc;l=706)）。`AudioDecoder` 與 `VideoDecoder` 共用這段程式。
- 回收的前提是 `is_applying_pressure_ && global_pressure_exceeded_ && is_backgrounded_` 三者都成立（[`reclaimable_codec.cc` L162](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/webcodecs/reclaimable_codec.cc;l=162)）。之後還要閒置 90 秒（`kInactivityReclamationThreshold`，[`reclaimable_codec.h` L34](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/webcodecs/reclaimable_codec.h;l=34)）而且連續兩次檢查都閒置，才會以 `QuotaExceededError` 回收（L185–197）。`decode()`、`flush()` 等呼叫都會 `MarkCodecActive()`，**持續解碼中的 decoder 不會被回收**。
- 全域門檻（[`codec_pressure_gauge.cc` L21–33](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/webcodecs/codec_pressure_gauge.cc;l=21)）：Windows 的 decoder 6 個、ChromeOS 3、Mac 24、Android 4（與 encoder 共用），其他（Linux）0。
- **哪些音訊 decoder 算 platform decoder**：
  - `DefaultDecoderFactory::CreateAudioDecoders` 的順序是 Symphonia（`kSymphonia*Decoding` 預設開）→ `OpusAudioDecoder`（`kDirectOpusAudioDecoding` 預設開）→ `FFmpegAudioDecoder` → external factory 的 `MojoAudioDecoder`（[`default_decoder_factory.cc` L63–113](https://source.chromium.org/chromium/chromium/src/+/main:media/renderers/default_decoder_factory.cc;l=63)）。selector 會選第一個支援的。
  - 只有 `MojoAudioDecoder::IsPlatformDecoder()` 回 true（[`mojo_audio_decoder.cc` L40](https://source.chromium.org/chromium/chromium/src/+/main:media/mojo/clients/mojo_audio_decoder.cc;l=40)），其他都沿用 `Decoder::IsPlatformDecoder()` 的 false。
  - Mojo 的 audio decoder 只在 Android、Mac、Win 編入（[`media_options.gni` L309–324](https://source.chromium.org/chromium/chromium/src/+/main:media/media_options.gni;l=309)），而 GPU process 回報的 platform 音訊 config 只有：Android 9+ 的 xHE-AAC（MediaCodec，[`gpu_mojo_media_client_android.cc` L89–95](https://source.chromium.org/chromium/chromium/src/+/main:media/mojo/services/gpu_mojo_media_client_android.cc;l=89)），Mac 的 xHE-AAC 與 AC-3／E-AC-3（AudioToolbox），Win 的 xHE-AAC、AC-3／E-AC-3、AC-4（Media Foundation）。
  - `IsDecoderAACSupported()` 對 xHE-AAC 以外的 AAC 一律回 true（`supported_types.cc` L296），代表一般 AAC 走軟體。**Chrome Android 的 FFmpeg build 內含 aac、flac、mp3、vorbis decoder 與 libopus**（`third_party/ffmpeg/chromium/config/Chrome/android/arm64/libavcodec/codec_list.c`），所以 Android 上這些 codec 也不經過 MediaCodec。
- **實測**（CDP media log，Linux）：AAC、Vorbis、PCM → `FFmpegAudioDecoder`，MP3、FLAC → `SymphoniaAudioDecoder`，Opus → `OpusAudioDecoder`，全部 `kIsPlatformAudioDecoder=false`。headless 無法把頁面切到背景，所以沒有實際等 90 秒。不過依上面的條件，軟體 decoder 不會進入回收流程。

**結論**：本 Engine 的音訊 codec（AAC-LC／HE-AAC、MP3、Opus、Vorbis、FLAC、PCM）在 Chromium 的任何平台都不會被 codec pressure 回收。會受影響的只有 xHE-AAC 與 Mac／Win 的 AC-3／E-AC-3（ADR-0003 的 wasm 本來就含 ac3／eac3）。而且就算是 platform decoder，也要在背景中閒置 90 秒才會被回收：鎖屏後持續播放時 decoder 一直有工作，不會被回收；但如果在背景暫停超過 90 秒再按播放，就可能收到 `QuotaExceededError` [推論]。

### 2.2 Android 鎖屏

- 會走 MediaCodec（platform）的只有 xHE-AAC [原始碼]。本 Engine 的其他 codec 與 wasm 路線一樣在 renderer 內解碼，鎖屏的風險在 process 層級（分頁凍結、renderer 被殺），兩條路線相同。
- 有聲音的分頁不會被凍結。這點對兩條路線一樣，需要在實機鎖屏清單裡驗證 [推論，未測]。

### 2.3 Safari 26 與 Firefox

- **WebKit**：`WebCodecsAudioDecoder::suspend()` 是空函式，只有在 context 被 `stop()` 時才關閉（[`WebCodecsAudioDecoder.cpp` L286–295](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webcodecs/WebCodecsAudioDecoder.cpp#L286)），沒有回收邏輯 [原始碼]。Cocoa 的 decoder 在 WebContent process 內用 AudioToolbox（`AudioSampleBufferConverter`）解碼。iOS 在背景時，WebContent process 是否被暫停取決於有沒有在播放聲音，兩條路線相同 [推論]。Safari 18.x 沒有 `AudioDecoder`（#5）。
- **Firefox**：`dom/media/webcodecs` 的 `DecoderTemplate.cpp`、`AudioDecoder.cpp` 沒有任何 reclaim 或背景相關的邏輯 [原始碼]。Firefox Android 沒有 WebCodecs（#5），而且 `CanDecodeAudio()` 在 Android 上對 AAC 直接回 false（`AudioDecoder.cpp` L140–142）。

## 3. 效益：CPU 時間

做法：封包事先讀進記憶體（不計 demux），每條路徑跑 3 次取中位數，以「所有瀏覽器 process 的 CPU ms ÷ 媒體秒」計算 [實測]。

- **wasm**：`ff_decode_filter_multi`，在 wasm 內解碼加上 filter graph（`atempo=1.25` → fltp），只把結果複製回 JS。這是 Engine 的實際路徑。
- **wasmNoFilter**：只解碼，並把每個 frame 複製回 JS。
- **ad**：`AudioDecoder` → `copyTo({format: "f32-planar"})` → 組成 libav.js frame → `ff_filter_multi`（複製進 wasm，同一個 `atempo=1.25` → fltp）→ 複製回 JS。
- **adNoFilter**：只做 `AudioDecoder` 加上 `copyTo(f32-planar)`。

| 瀏覽器 | 檔案 | wasm | wasmNoFilter | ad | adNoFilter | ad 相對 wasm |
|---|---|---|---|---|---|---|
| Chromium 153 | MP3 48k | 7.1 | 2.8 | 10.1 | 5.0 | +43% |
| | AAC 48k | 6.3 | 2.1 | 9.9 | 4.0 | +56% |
| | Opus 48k | 8.5 | 4.3 | 12.6 | 6.8 | +48% |
| | Vorbis 48k | 6.6 | 2.4 | 9.8 | 4.0 | +49% |
| | FLAC 48k／24 | 6.5 | 2.5 | 6.9 | 2.5 | +6% |
| | FLAC 192k／24 | 26.3 | 9.7 | 24.7 | 7.2 | −6% |
| | PCM s24 192k | 19.0 | 1.5 | **renderer crash** | crash | — |
| Firefox 155 | MP3 48k | 8.3 | 3.2 | 20.6 | 14.7 | +150% |
| | AAC 48k | 7.6 | 2.3 | 21.1 | 14.9 | +179% |
| | Opus 48k | 11.0 | 4.5 | 24.1 | 16.6 | +118% |
| | Vorbis 48k | 8.8 | 2.9 | 22.0 | 15.3 | +150% |
| | FLAC 48k／24 | 7.5 | 2.4 | 10.0 | 4.6 | +33% |
| | FLAC 192k／24 | 29.5 | 9.3 | 32.2 | 10.0 | +9% |
| | PCM s24 192k | 21.8 | 1.5 | （19.3）| （6.0） | 輸出只有 75%，數字無效 |
| WebKit 26.6（GStreamer） | MP3 48k | 7.4 | 3.1 | 10.8 | 6.0 | +45% |
| | AAC 48k | 6.9 | 2.3 | 9.2 | 4.3 | +33% |
| | Opus 48k | 9.0 | 4.5 | 13.1 | 8.4 | +46% |
| | Vorbis／FLAC | 7.1–29（Vorbis 的 wasm 數字受卡住的 decoder 干擾） | 2.6–9.8 | 解不出來 | — | — |
| | PCM s24 192k | 20.0 | 1.3 | 25.2 | 6.0 | +26% |

單位：CPU ms／媒體秒。wall time 與 CPU 時間大致相近：CPU 比 wall 多 0–25%，`AudioDecoder` 路徑的差距較大，代表有一部分工作在其他執行緒或 process 執行。兩條路線都沒有平行化。

解讀：

- **wasm 的解碼本身很便宜**：48k 的 lossy codec 只要 2.1–4.5 ms／媒體秒（約一個核心的 0.2–0.45%），已經包含 Asyncify 的 13–25% 代價（#17）。`AudioDecoder` 最多只能省下這部分，實際上省下的被 `AudioData` 的轉換、複製進 wasm、跨執行緒的成本吃掉了。
  - Chromium 的 MP3 與 Opus 輸出是 interleaved `f32`，要轉成 planar；FLAC 是 `s32`，要轉成 float。
  - Firefox 的 `AudioDecoder` 路徑特別貴（adNoFilter 就有 14–17 ms／媒體秒），推測是 decoder 在另一個 process（RDD）執行，資料要跨 process 傳回 [推論]。
- **filter graph 才是大頭**：同一個 `atempo=1.25` 在 48k 約 4–5 ms／媒體秒，192k 約 17 ms／媒體秒，兩條路線都要付。PCM 192k 的 wasm 解碼只有 1.5，加上 filter 變成 19。
- **192k／24-bit FLAC** 是唯一 `AudioDecoder` 比較便宜的情況，但只在 Chromium，而且只便宜 6%（1.6 ms／媒體秒）。
- **手機 [未測]**：`AudioDecoder` 背後是瀏覽器內建的 native decoder（有 NEON 等 SIMD），wasm 版本相對會慢更多，比例可能跟桌面不同。即使手機慢 10 倍，wasm 的 48k 解碼也只有 2–5% 的單核心；真正耗電的 filter graph 兩條路線都一樣。這需要實機數字確認（見第 5 節）。

## 4. `isConfigSupported` 的實際回報與誤報

### 4.1 codec 字串矩陣（不帶 description，取樣率 8k–384k × 1／2／6／8 聲道）[實測]

| codec 字串 | Chromium 153 | Firefox 155 | WebKit 26.6（GStreamer） |
|---|---|---|---|
| `mp4a.40.2`、`.40.5`、`.40.29`、`mp4a.67` | 全部 true | 全部 true | 全部 true（`mp4a.67` false） |
| `mp4a.40.42`（xHE-AAC） | false | false | false |
| `mp4a.69`、`mp4a.6B`（MP3 in MP4） | true | false | false |
| `mp3` | 全部 true | 全部 true | 全部 true |
| `opus` | 1／2ch true；6／8ch 不帶 description 丟 `TypeError` | 全部 true | 1／2ch true；6／8ch 丟 `TypeError` |
| `vorbis`、`flac` | 不帶 description 丟 `TypeError` | 全部 true | false（帶 description 時 true） |
| `pcm-u8`／`s16`／`s24`／`s32`／`f32`、`ulaw`、`alaw` | 全部 true | 全部 true | 全部 true |
| `ac-3`、`ec-3`、`mp4a.a5`、`mp4a.a6`、`alac`、`wavpack`、`dtsc` | false | false | false |

- 回報幾乎**與取樣率、聲道數無關**，連 384k 都是 true。Firefox 的判斷完全靠「猜一個容器類型再問 `CanHandleContainerType`」（`AudioDecoder.cpp` 的 `CanDecodeAudio()`），不看取樣率與聲道 [原始碼]。
- Linux 上沒有 platform decoder，所以 AC-3／E-AC-3／xHE-AAC 是 false。Mac／Win 的 Chrome 與 Safari 會不一樣 [未測]。

### 4.2 拿真實檔案 configure + decode [實測]

| 檔案（Engine 會給的 config） | Chromium 153 | Firefox 155 | WebKit 26.6 |
|---|---|---|---|
| AAC-LC 48k／2ch（ASC）、ADTS、6ch、96k | ✓ | ✓ | ✓ |
| MP3 44.1k、22.05k mono、8k mono | ✓ | ✓ | ✓ |
| Opus 48k／2ch（Ogg、WebM，OpusHead） | ✓（會裁 pre-skip） | ✓（會裁 pre-skip） | ✓（不裁） |
| Opus 6ch（OpusHead 27 B） | ✓ | ✓ | **誤報**：沒有輸出，`flush()` 不回應 |
| FLAC 48k／6ch／192k／384k（`fLaC`+STREAMINFO） | ✓（輸出 `s32`） | ✓ | **誤報**：`EncodingError: Decode error` |
| Vorbis 2ch／6ch（Xiph lacing） | ✓ | ✓（會出現 0 frame 的 `AudioData`） | **誤報**：沒有輸出，`flush()` 不回應，之後同一 process 的 `isConfigSupported` 也不回應 |
| PCM s24 96k／192k | **誤報**：`copyTo()`／`allocationSize()` 讓 **renderer crash** | **誤報**：只輸出 75% 的 sample（216000／288000），不報錯 | ✓ |
| PCM f32 48k | ✓ | ✓ | ✓ |
| ALAC | 正確回報不支援 | 正確回報不支援 | 正確回報不支援 |

- **Chromium 的 `pcm-s24` crash 最小重現**（[`m-s24.mjs`](../../research/audiodecoder-spike/m-s24.mjs)）：`configure({codec: "pcm-s24", sampleRate: 48000, numberOfChannels: 2})`，送 4 個 1024 frame 的靜音 chunk。只要在 output callback 裡對 `AudioData` 呼叫 `allocationSize()` 或 `copyTo()`，不論 format 給什麼（不給、`f32`、`f32-planar`）都會 crash；不呼叫就沒事。`pcm-s16`、`pcm-s32` 不會。CDP media log 顯示 PCM 走 `FFmpegAudioDecoder`，輸出格式是 `s24`，推測是 `AudioData` 對 S24 的大小計算有誤 [推論]。
- **漏報**：沒有發現回報 false 但實際能解的情況。
- **含意**：`isConfigSupported` 只能用來排除明顯不支援的 codec。要用 `AudioDecoder` 的話，必須在播放前實際解幾個封包，檢查輸出的 sample 數、取樣率、聲道是否正確，還要有 timeout。renderer crash 這種情況連驗證都擋不住，只能事先把組合列入黑名單。

## 5. 沒有測到的項目與實機清單

**[未測] 需要實機驗證**（建議加入實機清單）：

1. **Safari 26（macOS、iOS）的 `AudioDecoder`**：
   - AAC 的 priming 是否原樣輸出（AudioToolbox 的 converter 預設行為）。
   - Opus 帶 description 時是否裁 pre-skip、reset 後是否重裁（原始碼會傳 `preSkip` 給 converter）。
   - 負 timestamp 的處理。
   - FLAC、Vorbis 實際能否解（`AudioDecoderCocoa` 要求 description），`isConfigSupported` 有無誤報。
2. **手機的 CPU 與電量**（iOS Safari 26、中低階 Android Chrome）：同一個檔案用 wasm 與 `AudioDecoder` 各播 10 分鐘，包含 MP3／AAC 48k 與 FLAC 192k／24-bit。看 CPU 使用率（Android 用 `adb shell top`／Perfetto，iOS 用 Instruments）與電量。filter graph 要同時開（atempo 1.0 與 1.25 各一次）。
3. **Android Chrome 鎖屏 30 分鐘以上用 `AudioDecoder` 播放**：確認沒有 `QuotaExceededError` 或 error callback，並在背景暫停 2 分鐘後恢復播放，確認仍然可用（xHE-AAC 以外理論上不受影響）。
4. **Windows／macOS 的 Chrome**：用 `chrome://media-internals` 確認 AAC 走 `FFmpegAudioDecoder`（`kIsPlatformAudioDecoder=false`），以及 AC-3／E-AC-3 是否變成 platform decoder 並受 codec pressure 影響。
5. **Windows／macOS 的 Firefox**：AAC 改走 WMF／AudioToolbox，priming、timestamp、`pcm-s24` 的行為可能與 Linux 不同。

**其他 [未測]**：

- 實際把 Chromium 頁面切到背景、等 90 秒的回收實驗。headless 沒有可見度的切換，Linux 也沒有 platform decoder 可以觀察。
- HE-AAC（SBR）的 priming：image 內的 libfdk_aac 沒有 SBR，無法產生測試檔。HE-AAC 的 decoder delay 與 LC 不同，wasm 路線由 FFmpeg 處理，`AudioDecoder` 路線要另外確認。

## 6. 對選擇規則的含意（#19）

這一節只整理事實與推論，**不做決定**。

- **精準度沒有優勢**：`AudioDecoder` 輸出的是 decoder 的原始資料，品質與 FFmpeg 相同。但 Engine 要自己做 FFmpeg 在 wasm 裡自動做的裁切（skip side data、DISCARD 旗標），還要處理每家瀏覽器各自的怪癖：
  - Opus 的 pre-skip：Chromium、Firefox 每次 reset 都重裁，WebKit 不裁。
  - 負 timestamp：Chromium 改寫，WebKit 輸出錯亂。
  - Vorbis：Chromium 的 timestamp 差一個 block；Firefox 送 0 frame 的 `AudioData`。

  wasm 路線一套邏輯就能做到 sample 精準，`AudioDecoder` 路線要維護一張「瀏覽器 × codec」的修正表，Safari 的那一欄還是空的。
- **桌面的 CPU 沒有效益**：48k lossy 多 33–179%，FLAC 持平，只有 Chromium 的 192k FLAC 省 6%。兩條路線的大頭都是 filter graph（atempo），`AudioDecoder` 碰不到這部分。
- **背景回收不是問題**：本 Engine 的音訊 codec 在 Chromium 都是軟體 decoder，不會被回收；Firefox 與 WebKit 沒有回收機制。所以「被回收就切回 wasm」的情境在實務上幾乎不會發生，主要的切換理由會變成 configure 失敗、decode error 與上面的怪癖。
- **可靠性風險具體存在**：
  - Chromium 的 `pcm-s24` 會讓整個分頁 crash（不只是 Engine）。
  - Firefox 的 `pcm-s24` 會無聲無息地輸出錯誤的資料。
  - WebKit／GStreamer 的 FLAC、Vorbis、多聲道 Opus 會失敗或卡死，而且會拖累同一個 process 之後的 decoder。

  `isConfigSupported` 擋不住這些，要用 `AudioDecoder` 就必須有「試解驗證、timeout、黑名單」三道防線。
- **可能翻盤的只有手機**：native decoder 加上 SIMD 對比 wasm（加 Asyncify）在 ARM 上的差距可能比桌面大。但能省的上限是 wasm 解碼本身的成本（桌面 48k 只有 2–4.5 ms／媒體秒），filter graph 的成本不會變。
- **如果保留 `AudioDecoder` 路線**，資料支持的最小範圍大約是：只用於 AAC、MP3、FLAC（Chromium／Firefox），以及不帶 description 的 ≤ 2ch Opus；PCM、Vorbis、多聲道 Opus 一律走 wasm；chunk timestamp 一律 ≥ 0，不讀 `AudioData.timestamp`。**如果移出 v1**，需要更新 ADR-0003，並保留「解碼路線」這個 seam，等手機數據出來再評估。

## spike 的使用方式

```bash
# 1. build（需要 research/ffmpeg-wasm-build branch 的 research/build-spike）
research/audiodecoder-spike/build.sh <build-spike 目錄> <工作目錄>
# 2. 媒體（Docker 內的 ffmpeg 7.1）
research/audiodecoder-spike/gen-media.sh <媒體目錄>
# 3. 在 Playwright 1.63.0 的 Docker image 內跑（先在該目錄 npm install）
research/audiodecoder-spike/run-docker.sh <工作目錄>/libav.js/dist <媒體目錄> out.json chromium,firefox 'accuracy;seek;support;cpu'
#    WebKit 請每個檔案各跑一次，避免卡住的 decoder 拖累後面的測試：
#    ... webkit 'accuracy:{"files":["acc-aac.m4a"]};accuracy:{"files":["acc-mp3.mp3"]}'
#    Chromium 的 decoder 名稱：... chromium 'm-names:{"cdpMedia":true}'
#    Chromium pcm-s24 crash 最小重現：... chromium 'm-s24:{"copy":"f32-planar"}'
# 4. 整理成表格
node research/audiodecoder-spike/summarize.mjs out.json accuracy
node research/audiodecoder-spike/summarize-seek.mjs out.json
node research/audiodecoder-spike/summarize-cpu.mjs out.json
node research/audiodecoder-spike/summarize-support.mjs out.json
```

| 檔案 | 內容 |
|---|---|
| `t-accuracy.mjs` | 1.1／1.3：與 truth 和 FFmpeg 比較 lag、長度、差異與 timestamp |
| `t-seek.mjs` | 1.4：preroll 封包數與收斂 |
| `t-cpu.mjs` | 3：四條路徑的 CPU（`mark()` 由 runner 讀 `/proc`） |
| `t-support.mjs` | 4：`isConfigSupported` 矩陣與真實檔案驗證 |
| `t-pktinfo.mjs` | 頭尾封包的 pts、flags、skip side data |
| `m-names.mjs`、`m-s24.mjs` | Chromium 的 decoder 名稱（CDP）、`pcm-s24` crash 重現 |
| `codecpar-accessors.patch` | libav.js 的 `AVCodecParameters` accessor（`initial_padding` 等） |
| `data/*.json` | 本報告用到的原始結果 |

## 來源

- Chromium（main，2026-10）：
  - `third_party/blink/renderer/modules/webcodecs/`：`decoder_template.cc`、`reclaimable_codec.{h,cc}`、`codec_pressure_gauge.cc`、`audio_decoder.cc`（L345–347：WebCodecs 的 config `seek_preroll`／`codec_delay` 一律 0）、`audio_decoder_broker.cc`。
  - `media/renderers/default_decoder_factory.cc`、`media/mojo/clients/mojo_audio_decoder.cc`、`media/mojo/services/gpu_mojo_media_client_{android,mac,win}.cc`、`media/media_options.gni`、`media/base/media_switches.cc`（L525、L1231–1234）、`media/base/supported_types.cc`。
  - `media/filters/opus_audio_decoder.cc`（L378、L420–425）、`media/filters/ffmpeg_audio_decoder.cc`（L416–417、L457–465）、`media/filters/symphonia_audio_decoder.cc`。
  - `third_party/ffmpeg/chromium/config/Chrome/android/arm64/libavcodec/codec_list.c`。
- Gecko（mozilla-firefox/firefox main）：`dom/media/webcodecs/AudioDecoder.cpp`、`DecoderTemplate.cpp`、`WebCodecsUtils.cpp`（L650–658）。
- WebKit（main）：`Source/WebCore/Modules/webcodecs/WebCodecsAudioDecoder.cpp`、`Source/WebCore/platform/AudioDecoder.cpp`、`Source/WebCore/platform/audio/cocoa/AudioDecoderCocoa.cpp`。
- FFmpeg 9.0（libav.js build 使用的 tarball）：`libavcodec/decode.c`（L332–396）、`libavcodec/avcodec.c`（L365）、`libavcodec/codec_par.c`（L245–246）、`libavformat/demux.c`（L1536–1556）、`libavformat/mp3dec.c`（L262–268）、`libavformat/mov.c`、`libavformat/matroskadec.c`（L2897–2901）、`libavformat/oggparseopus.c`（L62）。
- libav.js 6.10.9.0：`funcs.json`、`src/p-avfcbridge.in.js`、`src/b-avcodec.c`。
- 規格：[RFC 7845 §4.6（Opus seek preroll）](https://www.rfc-editor.org/rfc/rfc7845#section-4.6)、[WebCodecs Codec Registry](https://www.w3.org/TR/webcodecs-codec-registry/)。
- 先前的 research：#5（WebCodecs 支援矩陣）、#10（wasm build）、#17（libav.js 執行期行為）、ADR-0003。
