# 音訊只用 wasm 解碼，影片只用 WebCodecs

音訊一律由 wasm 的 FFmpeg 解碼，不使用 `AudioDecoder`。解出的音訊以 fltp 送進 filter graph（重採樣、downmix、`atempo`），之後的處理只有一套。PCM 也走 wasm 的 decoder，JS 端不做任何樣本格式轉換。影片只用 WebCodecs 的 `VideoDecoder`，v1 不做軟體解碼備案；瀏覽器解不了的影片軌只播音訊。

## Considered Options

- **另做 `AudioDecoder` 路線，失敗時切回 wasm**：實測沒有任何一方面贏過 wasm。
  - 桌面上完整路徑（解碼 → fltp → `atempo`）的 CPU 多 33–179%，只有 Chromium 的 FLAC 192k 省 6%。wasm 解碼本身只要 2.1–4.5 ms／媒體秒，大頭是兩邊都要付的 filter graph。
  - `AudioDecoder` 什麼都不裁，Engine 要依 `AV_PKT_DATA_SKIP_SAMPLES` 自己裁，還要維護「瀏覽器 × codec」的 timestamp 修正表：負 timestamp、Opus 在 reset 後重裁 pre-skip、Vorbis 的偏移。
  - `isConfigSupported` 擋不住實際的失敗：Chromium 的 `pcm-s24` 會讓 renderer crash，WebKit／GStreamer 的 FLAC 失敗、Vorbis 卡死。
  - 原本擔心的背景回收不成立：本 Engine 的音訊 codec 在 Chromium 都是軟體 decoder，不受 codec pressure 影響。
  - 唯一可能翻盤的是手機的 CPU 與電量，但能省的上限只有 wasm 解碼本身那一段。
- **以 `AudioDecoder` 為主、wasm 為輔**：Safari 18 沒有 `AudioDecoder`，Firefox Android 沒有 WebCodecs，ALAC、WavPack、f64 PCM 任何瀏覽器都不支援，wasm 無論如何都要支援全部 codec。
- **PCM 在 JS 直接轉換**：只省下幾 KiB 的 decoder，卻要多測一條路線；而且 libav.js 取不出 f64 的 frame，本來就要經過 filter graph。
- **Safari 的 AV1 用 wasm 的 dav1d 解碼**（WebKit 在 Cocoa 預設關閉 WebCodecs 的 AV1，有硬體 decoder 的新機也一樣）：代價大，換來的只有 720p 大概能即時。
  - 單執行緒跟不上 1080p：在桌面一顆 Zen 2 核心上，Engine 現在的編譯條件（`-Oz`、Asyncify）只有 0.44–0.82 倍即時。dav1d 改用 `-O3 -msimd128` 後，動畫 1.1–1.5 倍，實拍仍只有 0.75–0.99 倍。手機的門檻要實機數據才能定。
  - 一個 alt-ref 封包要解 300 ms 以上，會佔住 Worker。和音訊同在 media Worker 會擋住音訊供料，所以要另開 Worker。
  - 2 threads 才夠解實拍 1080p，但需要 COOP/COEP。
  - WebKit 與 Firefox 不能用 10-bit buffer 建 `VideoFrame`，10→8 bit 的轉換要寫在 wasm 內。
  - AV1 的 frame 幾乎都是 reference frame，丟 frame 省不到解碼時間。
  - libav.js 的 dav1d 只在 master，還沒有 release。
- **Firefox Android 也做軟體解碼**：Firefox Android 沒有 `VideoFrame`，要另寫 WebGL 的 YUV 繪製路徑，還要 H.264 與 VP9 的軟體 decoder。

## Consequences

- wasm variant 為 `kikoeru-af` 加上 avi、aiff demuxer 與 ac3、eac3 decoder（含 ac3 parser）。新增 codec 只要改 variant、重新發一版 wasm。
- 影片軌不支援時不讓 `load()` 失敗，只播音訊；只有完全沒有可播的軌才回報 `CODEC_UNSUPPORTED`。`isEngineSupported()` 不要求 WebCodecs。Safari 上的 AV1 與 Firefox Android 的影片軌都標為 `unsupportedReason: 'platform'`。
- encoder delay 由 libavcodec 依封包的 skip samples 自動裁掉。ADTS 與沒有 LAME header 的 MP3 沒有這項資訊，開頭的 priming（約 23–25 ms）照原樣輸出，不猜測固定值。
- 精準 seek 指輸出的第一個 sample 位置精準；內容收斂到 codec 的 preroll 能達到的程度。preroll：AAC 1 個 frame、MP3 2 個、Vorbis 1 個封包、FLAC 與 PCM 不需要、Opus 取容器的 `seek_preroll` 與 80 ms 中較大者。seek 時用 `avcodec_flush_buffers`，不關閉重開 decoder，避免重裁 `initial_padding`。
- 解碼器只在 media Worker 內產出 fltp 送進 filter graph，日後若手機實測顯示 CPU 或電量有問題，可以在這個接縫加回 `AudioDecoder`，範圍限於 AAC、MP3、FLAC 與不帶 description 的 ≤ 2ch Opus。
- 影片的繪製路徑只接受 `VideoFrame`，不管 frame 從哪裡來。日後加入 wasm 軟體解碼時，只是在 Worker 內多一條產出 `VideoFrame` 的路，不必改公開 API。
