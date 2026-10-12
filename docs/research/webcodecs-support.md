# Research：WebCodecs 支援矩陣

- Ticket：[#5](https://github.com/mocukie/kikoeru-player/issues/5)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)）
- 調查日期：2026-10-12
- 瀏覽器範圍：近兩年（2024-10 ~ 2026-10）。對應版本約為 Chrome 130–155、Firefox 131–157、Safari 18.0–27（macOS 與 iOS）[^bcd-browsers]。

## 結論摘要

1. **AudioDecoder 不能當成可依賴的音訊路徑。** Safari 要到 26（2025-09）才有 AudioDecoder，Safari 18.x 沒有；Firefox for Android 連 WebCodecs 本身都沒有開；ALAC、WavPack、f64 PCM 不在 WebCodecs codec registry 裡，任何瀏覽器都不支援。所以不論如何都需要 wasm 音訊解碼，「音訊全部走 wasm」這個決定成立，而且是最簡單的做法。
2. **VideoDecoder 在三大桌面瀏覽器與 iOS Safari 都有**（Chrome 94、Firefox 130、Safari 16.4 起），H.264 與 VP9 可以當基本盤。HEVC 依平台而定：Chromium 只走硬體，Firefox 正式版沒有開，Safari 有。AV1 在 Safari 的 WebCodecs **沒有開**（WebKit 設為 preview）。
3. **Firefox for Android 沒有 WebCodecs**（只有 Nightly 開）。音訊走 wasm 時，Android Firefox 仍能播純音訊；影片要等 [延] 的 wasm 影片解碼備案。
4. **Playwright 1.57 起改用 Chrome for Testing**，內建 H.264 與 AAC。實測 Playwright 1.63（Chrome 153）的 headless shell 與 `channel: 'chromium'` 都能解 H.264、VP9、AV1、AAC、MP3。HEVC 在沒有 GPU 的 Linux 容器回報不支援，E2E 只能測「不支援時的錯誤路徑」。
5. **`isConfigSupported()` 只回答「大致支援這個 codec」**，不保證 `configure()` 或 `decode()` 會成功。已知有回報 `supported: true` 但解碼時發生 `EncodingError` 的案例。Engine 必須把解碼錯誤當成正常的失敗路徑處理。
6. **Worker 與 transfer 都有支援。** 規格與三家的 IDL 都把 VideoDecoder 與 VideoFrame 暴露在 DedicatedWorker，VideoFrame 是 Transferable。實測三個引擎在 Worker 內解碼，再把 VideoFrame transfer 回主執行緒都成功。
7. **背景分頁：Chromium 會回收（reclaim）閒置的硬體 decoder**，條件是分頁在背景、90 秒沒有輸出、且全域 codec 壓力超過門檻（Linux 門檻為 0），回收時以 `QuotaExceededError` 關閉 decoder。Engine 在背景停止餵影片，正好會讓 decoder 變成閒置，所以必須處理這個錯誤，或在背景時主動 close。Firefox 與 WebKit 的 WebCodecs 程式碼裡沒有對應的回收機制；iOS 鎖屏後的實際行為未驗證，要列入實機鎖屏清單。

## 1. API 可用性

| 項目 | Chrome／Edge（桌面、Android） | Firefox 桌面 | Firefox Android | Safari macOS／iOS |
| --- | --- | --- | --- | --- |
| `VideoDecoder` | 94+ | 130+ | ✗（只有 Nightly） | 16.4+ |
| `AudioDecoder` | 94+ | 130+ | ✗ | **26+**（18.x 沒有） |
| 在 DedicatedWorker 內使用 | ✔ | ✔ | — | ✔（IDL）；實機未驗證 |
| `VideoFrame` transfer（postMessage） | ✔ | ✔ | — | ✔（IDL）；實機未驗證 |
| 需要 secure context | 是 | 是 | — | 是 |
| 其他限制 | — | — | — | Lockdown Mode 下停用 WebCodecs 影片 |

來源：MDN browser-compat-data[^bcd]、Firefox 130 release notes[^ff130]、Firefox `StaticPrefList.yaml`（`dom.media.webcodecs.enabled` 在 Android 只有 Nightly 為 true）[^ff-prefs]、WebKit Safari 26.0 features[^safari26]、WebKit `UnifiedWebPreferences.yaml`（`WebCodecsVideoEnabled` 設有 `disableInLockdownMode: true`）[^wk-prefs]、規格的 IDL（`[Exposed=(Window,DedicatedWorker), SecureContext]`；VideoFrame 為 `Serializable, Transferable`）[^spec]。

Secure context：kikoeru 正式環境走 HTTPS，`localhost` 也算 secure context，所以 Demo 頁與 E2E 不受影響。

## 2. VideoDecoder codec 支援

| Codec | Chromium（Chrome 品牌版） | Firefox 桌面（正式版） | Safari macOS／iOS |
| --- | --- | --- | --- |
| H.264（avc1） | ✔ 軟體（FFmpeg）＋硬體 | ✔ 走作業系統或系統函式庫的 decoder；High10 回報 ✗（實測） | ✔ VideoToolbox |
| HEVC（hev1／hvc1） | **只有硬體**：Windows、macOS、Android、ChromeOS 從 107 起，Linux 從 108 起（需要 VA-API）；沒有軟體備援 | ✗（`dom.media.webcodecs.h265.enabled` 只有 Nightly 開） | ✔（WebKit 在 Cocoa 預設開啟；最早的出貨版本未查證） |
| VP8 | ✔ | ✔ | ✔ 軟體（libwebrtc libvpx） |
| VP9 | ✔ 軟體（libvpx）＋硬體；profile 0、2 都回報 ✔ | ✔ profile 0、2 | ✔ profile 0（8-bit 4:2:0）與 profile 2（10-bit 4:2:0），軟體（libwebrtc） |
| AV1 | ✔ 軟體（dav1d）＋硬體；8-bit、10-bit 都回報 ✔ | ✔（8-bit、10-bit 都回報 ✔） | **✗**（`WebCodecsAV1Enabled` 在 Cocoa 預設 false，狀態為 preview） |

依據：

- Chromium：`media/base/supported_types.cc`。H.264 只在 `USE_PROPRIETARY_CODECS` 時支援；HEVC 需要 `ENABLE_PLATFORM_HEVC`，且依硬體 profile cache 判斷；AV1 需要 `ENABLE_AV1_DECODER`，或 Android 10 以上[^cr-supported]。HEVC 各平台的起始版本來自 StaZhu 整理的 HEVC 說明（**次級來源**，未逐版查證）[^stazhu]。
- Firefox：pref 定義[^ff-prefs]，以及 §4 的實測結果。Firefox 桌面 H.264 與 AAC 依賴作業系統的 decoder（Linux 上依賴系統函式庫），這點只有 Mozilla 支援頁的片段可佐證，**未完整查證**[^sumo]。
- Safari：WebKit `WebCodecsVideoDecoder.cpp` 的 `isSupportedDecoderCodec()`（avc1、vp8 一律接受；vp09 檢查 profile、bit depth 與 4:2:0；hev1／hvc1 看 `webCodecsHEVCEnabled`；av01 看 `webCodecsAV1Enabled`）[^wk-vdec]，`VideoDecoder.cpp`（Cocoa 上 VP8、VP9、AV1 走 `LibWebRTCVPXVideoDecoder`）[^wk-vdec-platform]，以及 pref 預設值[^wk-prefs]。另外 `WebCodecsHighBitDepthEnabled` 預設 false，10-bit 來源輸出的 pixel format 可能被轉成 8-bit（**未驗證**）。

影響：v1 基本盤是 H.264＋VP9。AV1 只有 Chromium 與 Firefox 能用；Safari 遇到 AV1 必須在播放前回報不支援，直到 [延] 的 dav1d 備案。HEVC 一律要先用 `isConfigSupported()` 查詢，而且在 Chromium 上無法保證。

## 3. AudioDecoder codec 支援

| Codec | Registry 字串 | Chromium | Firefox 桌面 | Safari 26+ | Safari 18.x |
| --- | --- | --- | --- | --- | --- |
| AAC-LC／HE-AAC／HE-AACv2 | `mp4a.40.2`／`.5`／`.29` | ✔（xHE-AAC 只走平台 decoder） | ✔ | ✔ | ✗ |
| AAC（MPEG-2） | `mp4a.67` | ✔ | ✔ | ✗（不在允許清單） | ✗ |
| MP3 | `mp3`（`mp4a.69`／`mp4a.6B`） | ✔（兩種寫法都 ✔） | `mp3` ✔；`mp4a.69`／`6B` ✗ | `mp3` ✔ | ✗ |
| Opus | `opus` | ✔ | ✔ | ✔ | ✗ |
| Vorbis | `vorbis` | ✔ | ✔ | ✔（程式碼有列；能否解碼看 AudioToolbox，**未驗證**） | ✗ |
| FLAC | `flac` | ✔ | ✔ | ✔ | ✗ |
| PCM | `pcm-u8`／`s16`／`s24`／`s32`／`f32`，`ulaw`、`alaw` | ✔ | ✔ | ✔ | ✗ |
| PCM f64、big-endian | 不在 registry | ✗ | ✗ | ✗ | ✗ |
| ALAC | 不在 registry | ✗ | ✗ | ✗ | ✗ |
| WavPack | 不在 registry | ✗ | ✗ | ✗ | ✗ |
| AC-3／E-AC-3 | 不在 registry | ✗ | ✗ | ✗ | ✗ |

依據：W3C WebCodecs Codec Registry（2026-09-24）只列了 flac、mp3、mp4a、opus、vorbis、ulaw、alaw、pcm-*[^registry]；Chromium `IsDefaultDecoderSupportedAudioType()`[^cr-supported]；WebKit `AudioDecoder::isCodecSupported()` 與 `AudioDecoderCocoa::isCodecSupported()`[^wk-adec]；Chromium 與 Firefox 的欄位另有 §4 的實測結果。Firefox Android 沒有 AudioDecoder。

FLAC 與 Vorbis 的 registry 規定 `description` 為必填。Firefox 曾因 `isConfigSupported()` 沒帶 description 就回報不支援而修正（bug 1915002，Firefox 131）[^bz1915002]。

## 4. Playwright 與 E2E

**背景。** Playwright 文件說開源 Chromium 沒有 Chrome／Edge 內建的所有 codec[^pw-browsers]。但 **Playwright 1.57 起改用 Chrome for Testing**：headed 模式使用 `chrome`，headless 模式使用 `chrome-headless-shell`；Linux arm64 仍然使用 Chromium[^pw-release]。

**實測**（2026-10-12，Docker 映像 `mcr.microsoft.com/playwright:v1.63.0-noble`，x86_64，沒有 GPU；媒體由 FFmpeg 7.1 產生，每個影片只有一張 keyframe）：

| 項目 | chrome-headless-shell（預設） | `channel: 'chromium'`（新 headless） | Playwright Firefox 155 | Playwright WebKit 26.6（Linux，GStreamer） |
| --- | --- | --- | --- | --- |
| 版本 | 153.0.8010.12 | 153.0.8010.12 | 155.0 | 26.6 |
| H.264 High 實際解碼 | ✔ | ✔ | ✔ | ✔ |
| H.264 High10 `isConfigSupported` | ✔ | ✔ | ✗ | ✔ |
| HEVC Main 實際解碼 | ✗（`isConfigSupported` false，`configure` 拋 `OperationError`） | ✗ | ✗ | ✔ |
| VP9 p0 實際解碼／p2 `isConfigSupported` | ✔／✔ | ✔／✔ | ✔／✔ | ✔／✗ |
| AV1 8-bit 實際解碼 | ✔ | ✔ | ✔ | **`isConfigSupported` 為 true 但 decode 回 `EncodingError`** |
| AAC-LC（ADTS）實際解碼 | ✔ | ✔ | ✔ | ✔ |
| MP3 實際解碼 | ✔ | ✔ | ✔ | ✔ |
| Worker 解碼 VP9 並 transfer VideoFrame 回主執行緒 | ✔（codedWidth 384，原始寬 320） | ✔ | ✔ | ✔ |
| `alac`、`ac-3`、`ec-3` | ✗ | ✗ | ✗ | ✗ |

結論：

- E2E 用 Playwright Chromium（≥ 1.57），可以測 H.264、VP9、AV1 與 AAC、MP3、Opus 等格式，**不需要**另外裝 `channel: 'chrome'`。
- HEVC 在 Linux CI 無法測到成功路徑。改裝 Google Chrome stable（`channel: 'chrome'`）也一樣，因為 Chromium 的 HEVC 只走硬體，沒有 GPU／VA-API 就沒有。E2E 改測「HEVC → 播放前回報不支援」。
- Playwright WebKit 在 Linux 是 GStreamer 後端，codec 行為和 Safari（VideoToolbox／libwebrtc）不同，不能拿來代表 Safari。
- 注意 Chromium 輸出的 `codedWidth` 會對齊（320 → 384）。畫面要用 `displayWidth`／`visibleRect` 繪製。
- kikoeru 前端的 Playwright 版本若低於 1.57，Chromium 沒有 H.264／AAC。本 repo 要鎖在 ≥ 1.57。

探測用的程式碼在本 research 期間只放在 scratch 目錄，沒有進 repo。核心作法如下：

```js
// 在 https 頁面（可用 page.route 偽造 https://wc.test/）中執行
const r = await VideoDecoder.isConfigSupported({ codec: 'avc1.64001F', codedWidth: 1920, codedHeight: 1080 });
// 再用一張 keyframe（Annex B，不帶 description）實際 configure → decode → flush，確認有 output
```

## 5. `isConfigSupported()` 的可靠度

- **規格立場：** `configure()` 會再檢查一次支援度，不支援時以 `NotSupportedError` 關閉 decoder[^spec]。Mozilla 的 Paul Adenot 在 bug 1915002 說明，這個檢查「刻意不做得很徹底」，只回答實作是否大致支援某個 codec，因為它在下載媒體之前呼叫，拿不到 description[^bz1915002]。
- **已知的「回報支援但實際失敗」：**
  - WebKit bug 262950：HEVC `hev1.1.6.L90.90` 的 `isConfigSupported` 為 true，decode 時卻發生 `EncodingError: Decoder failure`。VideoToolbox 回傳 -12909；2023-12 修過一次，之後 reopen[^wk262950]。
  - WebKit bug 310192：GStreamer 後端的 decode 上限沒有套用到 `isConfigurationSupported()`，2026-03 修正（標題與內容只從搜尋摘要確認，**未逐字查證**）[^wk310192]。
  - 本次實測：Playwright WebKit（GStreamer）的 AV1 回報支援，但 decode 回 `EncodingError`（§4）。
  - Chromium 的 HEVC 依硬體 profile cache 判斷，回報的是 profile 層級，不涵蓋解析度或 level 等硬體上限（從原始碼推論[^cr-supported]，**未實機驗證**）。
- **Engine 的做法：**
  1. 開檔前以 `isConfigSupported()` 加上 wasm decoder 清單初步判斷，不支援就回報明確錯誤（map 的 [必] 項目）。
  2. `configure()` 失敗（`NotSupportedError`）和第一個 keyframe 的 decode 失敗（`EncodingError`）也要歸到同一類「格式不支援」錯誤碼，不能當成內部錯誤。
  3. 要真正確認，只能實際解碼第一個 keyframe。可以考慮在 probe 階段先試解一張。

## 6. Worker 與 VideoFrame transfer

- 規格：VideoDecoder、AudioDecoder、EncodedVideoChunk、VideoFrame、AudioData 都是 `[Exposed=(Window,DedicatedWorker)]`。VideoFrame 與 AudioData 是 `Serializable, Transferable`，EncodedVideoChunk 只有 `Serializable`[^spec]。
- WebKit IDL：`WebCodecsVideoDecoder.idl`、`WebCodecsAudioDecoder.idl` 為 `Exposed=(Window,DedicatedWorker)`；`WebCodecsVideoFrame.idl` 為 `Serializable, Transferable`[^wk-idl]。
- 實測：Chromium 153、Firefox 155、WebKit（Linux）都能在 Worker 內解碼 VP9，並以 `postMessage(frame, [frame])` transfer 到主執行緒（§4）。
- 實機 Safari（macOS、iOS）上 Worker 內解碼與 transfer 的實際行為**未驗證**，建議列入實機清單。
- 只在 Window 或 DedicatedWorker 可用：SharedWorker、ServiceWorker、AudioWorklet 都不行。

## 7. 背景分頁與鎖屏

**規格（Resource Reclamation）**[^spec]：

- UA 可以回收 codec，做法是以 `QuotaExceededError` 執行 close。
- 「active」的定義是 10 秒內 codec work queue 有進展，例如有 `output()`。「background」的定義是 document 的 `hidden` 為 true。
- 不得回收「active 且在前景」的 codec。背景中 active 的 AudioDecoder，只在分頁正發出聲音時受到保護；背景的 VideoDecoder 沒有這項保護。

**Chromium 實作**[^cr-reclaim]：

- 只有 platform decoder（硬體或 OS decoder）會施加 codec pressure，軟體 decoder（FFmpeg、libvpx、dav1d）不會被回收（`decoder_template.cc`：`IsPlatformDecoder()` 時才 `ApplyCodecPressure()`）。
- 回收條件：分頁在背景、全域壓力超過門檻、閒置 ≥ 90 秒（`kInactivityReclamationThreshold = 90s`），並且要連續兩次 timer tick 都判定閒置。
- 門檻（同一個 process 內施加壓力的 codec 數量）：Windows 的 decoder 為 6，macOS 為 24，Android 為 4，ChromeOS 為 3，**Linux 等其他平台為 0**（任何硬體 codec 都可能被回收）。
- 錯誤訊息為 `"Codec reclaimed due to inactivity."`。

**Firefox：** `dom/media/webcodecs/DecoderTemplate.cpp` 裡沒有 reclaim 或 visibility 相關邏輯[^ff-decoder-template]，看起來沒有實作回收。這是從原始碼搜尋得到的推論，**未實測**。

**WebKit：** `WebCodecsVideoDecoder::suspend()` 是空函式，WebCodecs 本身沒有回收邏輯[^wk-vdec]。不過 iOS 在背景或鎖屏時，會受到 process 暫停與 GPU process 或 VideoToolbox session 失效等系統行為影響，實際表現**未驗證**。

**對 Engine 的意涵：**

- map 已決定「背景或鎖屏時停止解碼影片、只播聲音」。停止餵資料後，VideoDecoder 在 Chromium 上會符合回收條件。
- 做法一：`visibilitychange` 為 hidden 時，Engine 主動 `close()` VideoDecoder 並丟掉影片封包。回到前景時重新 `configure()`，從目前音訊時間往前找 keyframe 解碼並丟棄到目標時間。
- 做法二：保留 decoder，但把 `QuotaExceededError` 以及回前景後第一次 decode 的錯誤當成可恢復錯誤，走相同的重建流程。
- 建議採用做法一，因為行為在三家一致，也不會占用硬體 decoder 名額。iOS 鎖屏時的行為放進實機鎖屏清單驗證。
- Engine 不使用 WebCodecs 的 AudioDecoder，所以「AudioDecoder 在發聲時不可回收」這條保護與 Engine 無關。音訊在 wasm 裡解碼，不受 codec 回收影響，這也是音訊走 wasm 的一個優點。

## 8. 對「音訊全部走 wasm 解碼，WebCodecs 只解影片」的意涵

**支持這個決定的事實：**

1. **涵蓋率：** 近兩年範圍內，Safari 18.x 與 Firefox for Android 沒有 AudioDecoder。就算 Safari 26 以上有，ALAC、WavPack、f64 PCM 在任何瀏覽器都沒有（不在 registry），而 kikoeru 的音檔常見 FLAC、ALAC（m4a）、WAV（含 24／32-bit、float）與 WavPack。無論如何都要有 wasm 音訊 decoder，雙軌只會多一條需要測試的路徑。
2. **一致性：** WebCodecs 各家的 AudioData 格式、priming／padding（AAC encoder delay、MP3 gapless 資訊）處理方式與錯誤行為不一。全部走 FFmpeg，就能統一輸出成 float planar，並統一處理 sample 精準的 seek 與 start padding。這點是根據 FFmpeg 的既有行為推論，**本次未實測各瀏覽器的 priming 差異**。
3. **背景播放：** wasm 解碼不受 WebCodecs codec reclamation 影響（§7），鎖屏時只剩音訊管線也比較單純。
4. **Firefox for Android 降級：** 沒有 WebCodecs 時，音訊仍然可以播。kikoeru 的內容以音訊為主，這個降級可以接受。影片軌在播放前回報不支援。

**代價與要注意的事：**

1. wasm 要包含 aac、mp3、opus、vorbis、flac、alac、wavpack 與 PCM 的 decoder，bundle 會變大。可以靠 lazy load 與只開必要的 decoder 控制（另一張 build research 的範圍）。
2. AAC 與 MP3 在 FFmpeg 都有原生的 LGPL decoder，不需要啟用 GPL 元件。AAC 的專利或授權議題不在本 ticket 範圍內，**未查證**。
3. 音訊解碼的 CPU 成本落在 Worker 中的 wasm，對 192 kHz／24-bit 這類高取樣率檔案的負擔要在實作時量測（**未驗證**）。

**對影片端的結論：**

- 必須支援：H.264、VP9（三家都有 VideoDecoder 的環境下都能用）。
- 依平台：HEVC（Chromium 只有硬體、Firefox 正式版沒有、Safari 有）、AV1（Safari 沒有）。
- 沒有 VideoDecoder 的環境（Firefox Android）：只播音訊，影片軌回報不支援。
- 開檔前查詢 `isConfigSupported()`，但 `configure()` 與 decode 錯誤也要歸類為「格式不支援」錯誤碼（§5）。
- 背景時主動 close VideoDecoder，回前景時重建（§7）。

## 未驗證事項

- Safari（macOS、iOS）實機上的 HEVC、VP9、Worker transfer 與鎖屏行為；WebKit 開啟 HEVC 的最早出貨版本。
- Safari 26+ 的 Vorbis 與 FLAC 在 AudioToolbox 上是否真的能解碼（程式碼有列）。
- Firefox 桌面 H.264 與 AAC 在 Windows、macOS、Linux 各自依賴哪個平台 decoder（Mozilla 支援頁無法完整讀取）。
- Chrome for Android 的 H.264 是否一律走 MediaCodec，以及 AV1 是否依賴 Android 10 以上。
- Chromium HEVC 各平台起始版本（107／108）只有次級來源。
- WebKit bug 310192 的內容只從搜尋摘要確認。
- Firefox 沒有 codec 回收機制，這是從原始碼搜尋推論的。
- 各瀏覽器 AudioDecoder 的 priming／padding 差異。

## 來源

[^bcd]: MDN browser-compat-data，`api/VideoDecoder.json`、`api/AudioDecoder.json`、`api/VideoFrame.json`、`api/AudioData.json`（main 分支，2026-10-12 取得）。https://github.com/mdn/browser-compat-data/tree/main/api
[^bcd-browsers]: MDN browser-compat-data `browsers/*.json` 的版本發佈日期。https://github.com/mdn/browser-compat-data/tree/main/browsers
[^ff130]: MDN，Firefox 130 for developers：「The Web Codecs API is supported on desktop releases … Android support is enabled in the Nightly release」（bug 1908572）。https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/130
[^ff-prefs]: Firefox `modules/libpref/init/StaticPrefList.yaml`：`dom.media.webcodecs.enabled`（Android 為 `@IS_NIGHTLY_BUILD@`）、`dom.media.webcodecs.h265.enabled`（`@IS_NIGHTLY_BUILD@`）。https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/StaticPrefList.yaml
[^safari26]: WebKit blog，WebKit Features in Safari 26.0：「Safari 26.0 expands support for WebCodecs API by adding AudioEncoder and AudioDecoder.」https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ ；Safari 16.4 加入 WebCodecs 影片部分：https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
[^wk-prefs]: WebKit `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml`：`WebCodecsAV1Enabled`（preview，Cocoa 預設 false）、`WebCodecsHEVCEnabled`（Cocoa true）、`WebCodecsHighBitDepthEnabled`（false）、`WebCodecsVideoEnabled`（`disableInLockdownMode: true`）、`WebRTCVP9Profile2CodecEnabled`（Cocoa true）。https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml
[^spec]: W3C WebCodecs Working Draft，2026-10-07：§11 Resource Reclamation、各介面 IDL、`configure()` 的步驟。https://www.w3.org/TR/webcodecs/
[^registry]: W3C WebCodecs Codec Registry，Registry Draft，2026-09-24。https://www.w3.org/TR/webcodecs-codec-registry/
[^cr-supported]: Chromium `media/base/supported_types.cc`（main）。https://source.chromium.org/chromium/chromium/src/+/main:media/base/supported_types.cc
[^stazhu]: StaZhu，enable-chromium-hevc-hardware-decoding（次級來源）。https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding
[^sumo]: Mozilla Support，Audio and video files in Firefox（頁面無法完整載入，只看到搜尋摘要）。https://support.mozilla.org/en-US/kb/audio-and-video-firefox
[^wk-vdec]: WebKit `Source/WebCore/Modules/webcodecs/WebCodecsVideoDecoder.cpp`。https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webcodecs/WebCodecsVideoDecoder.cpp
[^wk-vdec-platform]: WebKit `Source/WebCore/platform/VideoDecoder.cpp`。https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/VideoDecoder.cpp
[^wk-adec]: WebKit `Source/WebCore/platform/AudioDecoder.cpp` 與 `Source/WebCore/platform/audio/cocoa/AudioDecoderCocoa.cpp`。https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/AudioDecoder.cpp
[^wk-idl]: WebKit `Source/WebCore/Modules/webcodecs/WebCodecsVideoDecoder.idl`、`WebCodecsVideoFrame.idl`、`WebCodecsAudioDecoder.idl`。https://github.com/WebKit/WebKit/tree/main/Source/WebCore/Modules/webcodecs
[^bz1915002]: Bugzilla 1915002，Check AudioDecoderConfig's description for some codecs（Firefox 131）。https://bugzilla.mozilla.org/show_bug.cgi?id=1915002
[^wk262950]: WebKit Bugzilla 262950，WebCodecs HEVC isSupported returns true but decoding failed（REOPENED）。https://bugs.webkit.org/show_bug.cgi?id=262950
[^wk310192]: WebKit Bugzilla 310192（GStreamer decode 上限與 isConfigurationSupported）。https://bugs.webkit.org/show_bug.cgi?id=310192
[^pw-browsers]: Playwright Docs，Browsers：「Chromium does not have all the codecs that Google Chrome or Microsoft Edge are bundling」。https://playwright.dev/docs/browsers
[^pw-release]: Playwright release notes v1.57：「Playwright now runs on Chrome for Testing builds rather than Chromium.」https://playwright.dev/docs/release-notes
[^cr-reclaim]: Chromium `third_party/blink/renderer/modules/webcodecs/` 下的 `reclaimable_codec.h`／`.cc`、`codec_pressure_gauge.cc` 與 `decoder_template.cc`（main）。https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/webcodecs/
[^ff-decoder-template]: Firefox `dom/media/webcodecs/DecoderTemplate.cpp`（main）。https://github.com/mozilla-firefox/firefox/blob/main/dom/media/webcodecs/DecoderTemplate.cpp
