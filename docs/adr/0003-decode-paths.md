# wasm 是音訊的完整解碼路線，影片用 WebCodecs 加 dav1d 備案

音訊的每個 codec 都必須能由 wasm 的 FFmpeg 解碼；`AudioDecoder` 只是另一條可選的路線，不能取代 wasm。兩條路線解出的音訊都以 fltp 送進同一個 filter graph（重採樣、downmix、`atempo`），之後的處理只有一套。PCM 也走 wasm 的 decoder，JS 端不做任何樣本格式轉換。影片用 WebCodecs 的 `VideoDecoder`；Safari 的 AV1 改用 wasm 的 dav1d 解碼，輸出包成 `VideoFrame`，繪製路徑不變。

## Considered Options

- **只用 wasm 解碼音訊**：實測每媒體秒只要 7–19 ms CPU，是即時速度的 120–230 倍，而且不受 Chromium 背景回收 decoder 影響。但沒有手機上的數字，`AudioDecoder` 可能省下的 CPU 與電量也沒有量過，所以保留它作為可選路線，預設用哪條等研究結果再決定。
- **以 `AudioDecoder` 為主、wasm 為輔**：Safari 18 沒有 `AudioDecoder`，Firefox Android 沒有 WebCodecs，ALAC、WavPack、f64 PCM 任何瀏覽器都不支援，wasm 無論如何都要支援全部 codec。
- **PCM 在 JS 直接轉換**：只省下幾 KiB 的 decoder，卻要多測一條路線；而且 libav.js 取不出 f64 的 frame，本來就要經過 filter graph。
- **Firefox Android 也做軟體解碼**：Firefox Android 沒有 `VideoFrame`，要另寫 WebGL 的 YUV 繪製路徑，還要 H.264 與 VP9 的軟體 decoder。v1 在那裡只播音訊。

## Consequences

- wasm variant 為 `kikoeru-af` 加上 avi、aiff demuxer 與 ac3、eac3 decoder（含 ac3 parser）。新增 codec 只要改 variant、重新發一版 wasm。
- 影片軌不支援時不讓 `load()` 失敗，只播音訊；只有完全沒有可播的軌才回報 `CODEC_UNSUPPORTED`。`isEngineSupported()` 不要求 WebCodecs。
- `AudioDecoder` 要自己處理 encoder delay（AAC priming、edit list、Opus pre-skip），才能維持 sample 精準的 seek；被回收或失敗時要能中途切回 wasm。
- dav1d 是 BSD-2，NOTICE 要一併列出。軟體解碼在不要求 COOP/COEP 的前提下只能用單一核心，跟不上時的處理方式另外決定。
