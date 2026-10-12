# Research：不變調變速（time-stretch）的函式庫

- Ticket：[#7](https://github.com/mocukie/kikoeru-player/issues/7)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)）
- 下游決策：[#13 音訊輸出排程與變速](https://github.com/mocukie/kikoeru-player/issues/13)
- 調查日期：2026-10-12
- 標記：**[已查證]** 有附一手來源（repo 原始碼、LICENSE、npm registry、官方文件）；**[推論]** 由原始碼推得、尚未實測；**[未查證]** 沒有找到一手來源，或需要實測才能回答。

## 結論摘要

1. **首選：FFmpeg 內建的 `atempo` filter**，跟 demux／解碼一起在 Worker 內的 FFmpeg wasm 執行。
   - 授權是 LGPL-2.1-or-later，沒有新增授權負擔。
   - 演算法是 WSOLA，適合人聲。0.5x–2x 在它的原生範圍內（0.5–100，超過 2 才會跳過樣本）。
   - 聲道數與取樣率都不限。`tempo` 可以在執行期以 command 調整。
   - libav.js 的 default variant 已經把它編進 wasm，所以可以確定能在 wasm 內 build。
2. **備案：Signalsmith Stretch**（MIT，header-only C++，官方有 wasm／AudioWorklet 版本）。
   - 等 `atempo` 的試聽結果不合格時才換。
   - 作者自己說 time-stretch 在 0.75x–1.5x 之間效果最好，0.5x 與 2x 是否可接受要試聽。
3. **SoundTouch（C++，LGPL-2.1）可用，但相對 `atempo` 沒有明顯優勢。** 兩者同屬 WSOLA，用它只是多一個 LGPL 元件要合規。
4. **排除**：
   - GPL：Rubber Band、rubberband-web。
   - SoundTouchJS：只支援立體聲；它是 LGPL 程式碼的衍生品，卻改以 MPL-2.0 發布，授權來源有疑慮。
   - Sonic：內部以 16-bit 儲存樣本，而且是為 2x 以上的倍率優化。
   - Phaze：只做 pitch-shift，而且已經不維護。
   - 瀏覽器的 `preservesPitch`：只作用於 media element，不適用於本專案的 WebAudio 輸出。
5. **時鐘換算一律由 Engine 自己維護一張 piecewise-linear 的時間對照表**（output frame ↔ media time）。
   - stretcher 輸出的時間戳是 output timeline，不是 source time（`atempo` 已由原始碼確認）。
   - 音軌 delay／offset 以 media time 計算，在送進 stretcher 之前套用。
6. **進入 #13 之前要先做的實測**：
   - 用 ASMR 素材做試聽，比較 `atempo`、Signalsmith、SoundTouch 在 0.5x、0.75x、1.25x、1.5x、2x 的表現。
   - 測 wasm 內的 CPU 使用量（48k 與 192k、立體聲）。
   - 量 libavfilter 讓 wasm 增加多少體積。

## 比較表

| 項目 | FFmpeg `atempo` | Signalsmith Stretch | SoundTouch（C++） | SoundTouchJS | Bungee | Sonic | Rubber Band |
|---|---|---|---|---|---|---|---|
| 授權 | LGPL-2.1+ [已查證] | MIT（依賴 signalsmith-linear 也是 MIT）[已查證] | LGPL-2.1（另有商業授權）[已查證] | MPL-2.0（v2 起；舊版 `soundtouchjs` 為 LGPL-2.1）[已查證] | MPL-2.0 [已查證] | Apache-2.0 [已查證] | GPL-2.0 或商業授權 [已查證] |
| 能否用於本專案 | 可以，跟 FFmpeg 一起合規 | 可以 | 可以，但多一份 LGPL notice 與原始碼提供 | 授權來源有疑慮（見下文） | 可以（MPL 是檔案層級的 copyleft） | 可以 | **排除** |
| 演算法 | WSOLA（time domain） | 以 STFT 為基礎的 phase vocoder 類演算法 | WSOLA（TDStretch） | WSOLA（SoundTouch 的移植），另有 phase vocoder 套件 | phase vocoder（granular） | 以 pitch period 為基礎（為語音設計） | — |
| 建議速度範圍 | 0.5–100；超過 2 會跳過樣本 [已查證] | 作者建議 0.75–1.5 [已查證] | 沒有明確上限 | 0.1–8（AudioParam 範圍） | 沒有明確上限，可以負速度 | 0.05–20，**為 2x 以上優化** [已查證] | — |
| 聲道數 | 不限（packed 格式）[已查證] | 不限 [已查證] | 最多 32 [已查證] | **只有立體聲** [已查證] | 不限 [已查證] | 最多 32 [已查證] | — |
| 高取樣率 | window = sample_rate/24，再進位到 2 的冪次，參數會隨取樣率縮放 [已查證] | preset 以秒為單位，會隨取樣率縮放 [已查證] | 參數以 ms 為單位 [已查證] | 同 SoundTouch | README 寫明「原則上支援任何實用的取樣率」[已查證] | 最高 500 kHz，但**內部是 16-bit** [已查證] | — |
| 樣本格式 | u8／s16／s32／flt／dbl，**只接受 packed**（不收 planar）[已查證] | float，每聲道一個 buffer | float 或 int16（compile 時選擇） | float，interleaved stereo | float | 內部存成 `short` [已查證] | — |
| 演算法延遲 | 約一個 window（48k 時約 43 ms）[推論] | default preset 的 block 為 120 ms、interval 為 30 ms，input 加 output latency 約一個 block [推論] | auto 模式下，sequence 從 0.5x 的 90 ms 線性降到 2x 的 40 ms，seek window 從 20 ms 降到 15 ms [已查證：`TDStretch.cpp`] | 自己的 auto 範圍：sequence 50–125 ms、seek window 15–25 ms [已查證] | 約 100 grains/s [已查證] | 小 | — |
| 體積 | 需要 libavfilter 核心、abuffer／abuffersink 與 atempo，增量**[未查證]** | npm 單檔 113.8 KB，gzip 後約 47.7 KB（wasm 以 base64 內嵌）[已查證，本地量測] | 自行 compile，**[未查證]** | processor 單檔 72.9 KB（JS）[已查證，本地量測] | 依賴 Eigen 與 pffft，自行 compile，**[未查證]** | 很小（單一 C 檔）| — |
| 能在 AudioWorklet 內執行嗎 | 不適合：要把整個 FFmpeg wasm 搬進 worklet | 可以，官方 npm 版就是 AudioWorklet [已查證] | 自行 compile 後可以 [推論] | 可以，官方就是 AudioWorklet [已查證] | 開源版沒有 web build；Bungee Pro（商業版）才有 [已查證] | 自行 compile 後可以 [推論] | — |
| 執行期改速度 | `tempo` 是 runtime command [已查證] | `schedule({rate})` 或改輸入輸出長度比 [已查證] | `setTempo()` | AudioParam | 每個 grain 都可以改 | `sonicSetSpeed()` | — |
| 維護狀況 | FFmpeg 主線 | 2026-09 仍有 push，npm 1.3.2（2025-06）| 2.4.1（2026-03），2026-04 仍有 commit | 2026-08 仍有 push | 2026-10 仍有 push | 2026-03 仍有 push | — |

來源：

- FFmpeg：[`af_atempo.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_atempo.c)、[`doc/filters.texi` 的 atempo 段落](https://github.com/FFmpeg/FFmpeg/blob/master/doc/filters.texi)、[`configure`](https://github.com/FFmpeg/FFmpeg/blob/master/configure)（`EXTERNAL_LIBRARY_GPL_LIST` 含 `librubberband`）。
- Signalsmith：[repo README](https://github.com/Signalsmith-Audio/signalsmith-stretch)、[`signalsmith-stretch.h`](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/main/signalsmith-stretch.h)、[`web/release/README.md`](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/main/web/release/README.md)、[`web/emscripten/compile.sh`](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/main/web/emscripten/compile.sh)、npm `signalsmith-stretch@1.3.2`。
- SoundTouch：[codeberg.org/soundtouch/soundtouch](https://codeberg.org/soundtouch/soundtouch)（`COPYING.TXT`、`include/STTypes.h`、`source/SoundTouch/TDStretch.h`）。
- SoundTouchJS：[cutterbl/SoundTouchJS](https://github.com/cutterbl/SoundTouchJS)（README、LICENSE、`packages/core/src/Stretch.ts`、`packages/audio-worklet/README.md`），npm `@soundtouchjs/audio-worklet@2.1.1`、`soundtouchjs@0.3.0`。
- Bungee：[bungee-audio-stretch/bungee](https://github.com/bungee-audio-stretch/bungee)（README、LICENSE、submodules）。
- Sonic：[waywardgeek/sonic](https://github.com/waywardgeek/sonic)（README、`sonic.h`、`sonic.c`）。
- Rubber Band：[breakfastquay/rubberband](https://github.com/breakfastquay/rubberband)、[delude88/rubberband-web](https://github.com/delude88/rubberband-web)（GitHub 授權欄位為 GPL-2.0）。
- Phaze：[olvb/phaze](https://github.com/olvb/phaze)。

## 各候選的細節

### FFmpeg `atempo`（首選）

- **授權**：檔頭為 LGPL-2.1-or-later [已查證]。它是 FFmpeg 本體的一部分，合規方式與 #10 的 FFmpeg build 相同，不需要另外處理。
- **演算法**：檔頭註解寫明「an implementation of WSOLA algorithm」，改寫自 Pavel Koshevoy 以 MIT 授權發布的 Apprentice Video `yaeAudioTempoFilter`。
  - 用 `av_tx`（FFT）計算 cross-correlation，找出最佳的 fragment 對齊位置 [已查證]。
- **多聲道**：
  - 做 correlation 之前，`yae_downmix()` 會先把各聲道混成單聲道，再把同一個位移套到所有聲道 [已查證]。
  - 因此聲道之間的時間對齊不會被打亂，這對 binaural／dummy head 錄音的 ASMR 定位很重要 [推論]。
  - 沒有聲道數上限，stride 的算法是 `sample_size * channels` [已查證]。
- **取樣率**：`window = sample_rate / 24`，再進位到 2 的冪次 [已查證]。
  - 44.1k 與 48k 時是 2048（約 43–46 ms）；96k 是 4096；192k 是 8192。
  - 每秒的運算量大致跟取樣率成正比 [推論]。
- **速度範圍**：0.5–100。文件說明 tempo 大於 2 時「will skip some samples rather than blend them in」，需要的話可以串接多個 atempo [已查證]。本專案的 0.5x–2x 剛好在不跳樣本的範圍內。
- **執行期調整**：`tempo` 帶有 `AV_OPT_FLAG_RUNTIME_PARAM`，`process_command` 收到後會呼叫 `yae_update()` [已查證]。實際做法是用 `avfilter_graph_send_command()` 改變速度，不需要重建 filter graph。
- **限制**：
  - 只接受 packed 格式，原始碼註解寫明「planar sample formats are not supported」[已查證]。解碼器輸出的 fltp 要先 interleave 成 flt：可以在 graph 裡加 `aformat`，也可以由 Engine 自己做。
  - 速度為 1.0 時**沒有 passthrough**，仍然會跑一遍 WSOLA [已查證：原始碼沒有 1.0 的分支]。Engine 應該在 1.0x 時自己 bypass，並處理進出 bypass 的接縫（例如短 crossfade）。
  - 輸出的 PTS 是 `start_pts + 已輸出的樣本數`，也就是 output timeline，不是 source time [已查證]。所以 Engine 必須自己維護時間對照表（見下文）。
- **能否在 wasm 內 build**：libav.js 的 `default` variant 的 `ffmpeg-config.txt` 含 `--enable-filter=atempo`、`aformat`、`aresample` [已查證：[configs/configs/default](https://github.com/Yahweasel/libav.js/tree/main/configs/configs/default)]。這證明 atempo 可以用 emscripten 編譯並執行。
- **執行位置**：放在 demux／解碼所在的 Worker，處理完再把結果送到輸出端。不適合放進 AudioWorklet，因為那樣要在 worklet 裡再載入一份 FFmpeg wasm。
- **體積增量**：需要開啟 `--enable-avfilter`，再加上 `abuffer`、`abuffersink`、`atempo`，並視需要加 `aformat`。增量多少 **[未查證]**，應該在 #10 的 build pipeline 中實際量測。
  - 如果 libavfilter 核心太大，可以考慮只抽出 `yae_*` 這段 WSOLA 自己包一層。它的上游是 MIT，但 FFmpeg 內的版本是 LGPL [推論，未評估工作量]。

### Signalsmith Stretch（備案）

- **授權**：MIT [已查證：`LICENSE.txt`]。唯一的依賴 [Signalsmith-Audio/linear](https://github.com/Signalsmith-Audio/linear) 也是 MIT [已查證]。
- **演算法**：README 說它採用 ADC22 演講〈Four Ways To Write A Pitch-Shifter〉的最終做法，在 STFT 的頻譜上做相位預測。
  - 多聲道時，每個 band 以能量最大的聲道為基準鎖定其他聲道的相位，所以聲道間的相位差會保留 [已查證：`signalsmith-stretch.h` 的 `maxChannel` 段落]。
- **速度範圍**：README 原文為「time-stretching sounds best for more modest changes (between 0.75x and 1.5x)」[已查證]。0.5x 與 2x 對人聲 ASMR 的表現 **[未查證]**，需要試聽。
- **延遲與 CPU**：
  - `presetDefault` 的 block 為 0.12 秒、interval 為 0.03 秒；`presetCheaper` 為 0.1 秒與 0.04 秒，而且預設開啟 `splitComputation` [已查證]。
  - 頻譜處理會集中在某些 render quantum 運算。`splitComputation` 會多加一個 interval 的 output latency，換取比較平均的 CPU 負載 [已查證：README]。這對 AudioWorklet 的即時執行緒很重要。
  - 實際 CPU 使用量 **[未查證]**。
- **Web 版本**：npm `signalsmith-stretch@1.3.2`。以 emscripten `-sSINGLE_FILE=1` 把 wasm 內嵌在 JS 中，並包成 AudioWorkletNode [已查證：`web/emscripten/compile.sh`]。
  - 原始大小 113.8 KB，gzip 後約 47.7 KB [已查證：本地量測 npm tarball]。
  - 它的高階 API 自己管理 input buffer（`addBuffers`／`dropBuffers`），並維護一張 input time 與 output time 的 `timeMap`。這會和 Engine 自己的 ring buffer 與時鐘重疊。
  - 如果採用它，建議直接 compile `signalsmith-stretch.h`，接在 Engine 自己的 AudioWorklet 或 Worker 裡，不要使用 npm 的 node [推論]。
- **適合的位置**：既可以放 AudioWorklet，也可以放 Worker。放在 AudioWorklet 時，改速度只受演算法延遲影響，不受 ring buffer 長度影響。

### SoundTouch（C++）

- **授權**：LGPL-2.1，另有「free of GPL limitations」的商業授權 [已查證：codeberg README、`COPYING.TXT`]。
- **版本**：2.4.1（2026-03），2026-04 仍有 commit [已查證]。
- **能力**：
  - `SOUNDTOUCH_MAX_CHANNELS` 為 32 [已查證：`include/STTypes.h`]。
  - 預設使用 float 樣本。
  - TDStretch 預設 overlap 為 8 ms，sequence 與 seek window 會依速度自動調整 [已查證：`TDStretch.h`]。
  - 自動調整的區間剛好是 0.5x–2.0x（`AUTOSEQ_TEMPO_LOW` 與 `AUTOSEQ_TEMPO_TOP`）[已查證：`TDStretch.cpp`]。
- **評估**：與 `atempo` 同屬 WSOLA。如果採用，要在 Engine 的 wasm 裡多 compile 一份 LGPL 程式碼，並多加一份 notice 與原始碼提供方式。
  - 它的好處是參數可以調（sequence、seek window、overlap），也有大量現成應用。
  - 是否值得取代 `atempo`，要看試聽結果 **[未查證]**。

### SoundTouchJS（排除）

- **授權**：
  - npm 上舊的 `soundtouchjs@0.3.0` 是 LGPL-2.1。
  - 新的 `@soundtouchjs/*@2.1.1` 是 MPL-2.0，README 寫「With significant rewrites, we have now moved off of the LGPL to the MPL-2.0」[已查證]。
  - 但 `packages/core/src/Stretch.ts` 的檔頭仍然列出 Olli Parviainen（SoundTouch 原作者）的版權 [已查證]。
  - 衍生自 LGPL 程式碼的部分能否改用 MPL 發布，**有授權來源的疑慮** [推論]。
- **能力**：sample buffer 介面寫明是「interleaved stereo」，correlation 也只有 stereo 版本 [已查證：`Stretch.ts`、`SampleBuffer.ts`]。不支援 5.1 原聲道，單聲道要先升成立體聲。
- **架構**：README 建議由 source 的 `playbackRate` 改速度，再讓 node 把 pitch 修回來，因為「SoundTouch's internal time-stretcher operates on small 128-sample blocks... can't produce enough output samples per block」[已查證]。這和 Engine 用 ring buffer 自己供料的架構不合。

### Bungee（可列為未來的候選）

- **授權**：MPL-2.0 [已查證]。依賴 Eigen（MPL-2.0）與 pffft [已查證：submodules]。
- **能力**：
  - phase vocoder，以 grain 為單位，速度可以連續變化，也支援 0 與負速度 [已查證]。
  - README 提到它「often used for... speeding up speech」。
  - 開源版沒有 web build。README 中的「Web AudioWorklet with SIMD128 WebAssembly」與「ready-to-use Web Audio implementation」都屬於商業版 Bungee Pro [已查證]。
- **評估**：要自己用 emscripten compile 並帶上 Eigen，體積與 CPU 都 **[未查證]**。目前沒有比 Signalsmith 更好的理由，先不列入 v1。

### Sonic（排除）

- **授權**：Apache-2.0 [已查證]。Android Media3（ExoPlayer）的 `SonicAudioProcessor` 就是用它的 Java 移植實作播放速度 [已查證：[androidx/media 的 `Sonic.java`](https://github.com/androidx/media/blob/main/libraries/common/src/main/java/androidx/media3/common/audio/Sonic.java)]，可見它在播放器上有實際應用。
- **排除理由**：
  - README 寫明「optimized for speed ups of over 2X」，本專案需要的是 0.5x–2x。
  - 內部的 `inputBuffer` 是 `short*`，float 輸入會被量化成 16-bit [已查證：`sonic.c`]，這對高解析度的 ASMR 素材不理想。
  - 授權面：Apache-2.0 與 LGPL-2.1-only 不相容。FFmpeg 是 2.1-or-later，可以改用 LGPLv3 條款組合 [推論]，但這只是多一個問題，沒有好處。

### Rubber Band、rubberband-web（排除）

- Rubber Band 是 GPL-2.0 或商業授權 [已查證]。FFmpeg 的 `configure` 把 `librubberband` 列在 `EXTERNAL_LIBRARY_GPL_LIST` [已查證]，所以 FFmpeg 的 `rubberband` filter 也會讓整個 build 變成 GPL。
- rubberband-web 是 GPL-2.0，而且從 2022-11 起就沒有更新 [已查證]。

### 其他

- **Phaze**：Unlicense。它只是 pitch-shifter（README：「Real-time pitch-shifter as a Web Audio worklet」），不做 time-stretch，最後一次 push 在 2023-04 [已查證]。排除。
- **瀏覽器原生的 `HTMLMediaElement.preservesPitch`**：只作用於 `<audio>`／`<video>` 的播放。Engine 自己解碼後送進 WebAudio，用不到它。

## AudioWorklet 或 Worker：time-stretch 該放在哪裡

| | 放在解碼 Worker（`atempo` 等） | 放在 AudioWorklet（Signalsmith 等） |
|---|---|---|
| 改速度的反應時間 | ring buffer 裡已經 stretch 過的音訊要先播完。或者丟掉這些音訊，從對照表算出 source 位置後重新 stretch，這需要保留最近一段已解碼的 PCM，或者重新 seek | 只受演算法延遲影響（大約 0.1 秒）|
| 即時執行緒的風險 | 沒有，CPU 尖峰只會讓預讀變少 | 頻譜運算集中在少數 render quantum，可能造成爆音，需要 `splitComputation` |
| wasm 的載入 | 和 FFmpeg 共用同一個 instance | AudioWorkletGlobalScope 沒有 `fetch`。要用 SINGLE_FILE 內嵌，或在主執行緒 compile 後透過 port 傳進去（Signalsmith 採用前者）[已查證]。各瀏覽器（特別是 Safari）的相容性 **[未查證]** |
| ring buffer 的資料 | 已經 stretch 過，時間對照表在 Worker 端建立 | 還是原始 PCM，worklet 端一邊 stretch 一邊回報播放位置 |
| 背景與鎖屏 | 依 #6 的結論 | 依 #6 的結論，而且 worklet 的負擔較重 |

建議 v1 採用 **Worker 端 `atempo`，並讓 ring buffer 保持短（幾百 ms）**。這樣改速度的延遲可以接受，也可以在改速度時直接丟掉 ring buffer 內未播放的部分，再從對照表算出的 source 位置重新供料。

ring buffer 的長度與供料方式交由 #6 與 #13 決定。v1 的介面設計要讓 stretcher 的實作可以替換，以後若改成 AudioWorklet 端的 Signalsmith，不需要改公開 API。

## 多聲道與高取樣率

- **先 downmix，再 stretch**：功能清單已經要求做 5.1 downmix。先 downmix 成立體聲再 stretch，運算量約減為 1/3 [推論]。
- **取樣率**：上述所有演算法的運算量都大致跟取樣率成正比。192k 立體聲大約是 48k 的 4 倍 [推論]。
  - 如果 #6 決定 AudioContext 依來源開成 96k／192k，stretch 就要在那個取樣率執行。
  - 如果 AudioContext 固定在裝置的取樣率，就應該先重採樣再 stretch。
  - 192k 在中低階手機上能否即時處理 **[未查證]**，需要實測。
- `atempo` 只收 packed 格式。若 Engine 的內部格式統一為 float planar（見功能清單），進 filter graph 之前要 interleave，出來之後再轉回 planar。用 `aformat`／`aresample`（libswresample，LGPL）可以在 graph 內完成。

## 變速時的時鐘換算

Stretcher 輸出的時間戳都在 output timeline 上（`atempo` 的 PTS 是「起點 + 已輸出的樣本數」[已查證]），所以 media time 必須由 Engine 自己換算。建議的做法：

1. **時間對照表（time map）**：
   - 每次改速度或 seek，就在 output timeline 上開一個新的 segment：`{ outStart（output frame）, mediaStart（秒）, rate }`。
   - 換算公式為 `mediaTime(outFrame) = mediaStart + (outFrame - outStart) / sampleRate * rate`。
   - Signalsmith 的 web wrapper 內部也維護同樣形狀的 `timeMap`（`input`、`output`、`rate`）[已查證：`web-wrapper.js`]，可以作為參考。
2. **音訊時鐘**：
   - AudioWorklet 回報已播放的 output frame 數，再由對照表換算成 media time。
   - `outputLatency + baseLatency` 是牆鐘秒數，換算成 media time 時要乘上該段的 `rate`。
   - 也就是說，喇叭此刻發出的聲音所對應的 media time，等於 `mediaTime(已播 frame) - (outputLatency + baseLatency) * rate`。
3. **stretcher 本身的延遲**：
   - `atempo` 在 reset 時把第一個 fragment 向左移半個 window，輸出 PTS 從 `start_pts` 開始。由此推論，輸出的第一個樣本對齊 source 起點，演算法延遲只表現為緩衝，不會造成 timeline 偏移 [推論，需要實測驗證對齊誤差]。
   - Signalsmith 則要依 README 用 `seek()` 預先送入 `inputLatency()` 個樣本，輸出端扣掉 `outputLatency()` 的 pre-roll [已查證：README]。
4. **改速度**：
   - 新 segment 的 `outStart` 是新速度實際生效的 output frame。
   - 如果做法是丟掉 ring buffer 尾端再重新供料，切點的 media time 就用舊 segment 換算，再從那個 source 位置 reset stretcher 後重新送入 PCM。
   - 切點要做短 gain ramp，避免爆音（這屬於 #13 的範圍）。
5. **音軌 delay 與外掛音軌 offset**：
   - offset 定義在 media time 上，例如「這條音軌比影片晚 0.2 秒」。
   - 在送進 stretcher **之前**套用，也就是 `sourceTime = mediaTime - offset`。
   - 這樣在 2x 播放時，offset 仍然是 0.2 秒的 media time（牆鐘只有 0.1 秒），A/V 關係不會因為速度而改變。
   - 外掛音軌是「取代」容器內的音軌，同一時間只有一條音軌進入 stretcher，所以不需要對多條音軌各自 stretch 再混音。
6. **影片**：依音訊時鐘換算出的 media time 挑選 frame。2x 時每秒要解碼與繪製的 frame 數加倍，背景或鎖屏時本來就不解碼影片（這屬於 A/V 同步與影片輸出的範圍）。

## 尚未回答、建議的下一步

- **試聽（品質）**：
  - 用實際的 ASMR 人聲素材（含 binaural），以原生 CLI 離線產生 0.5x、0.75x、1.25x、1.5x、2x 的結果做盲聽。這不需要 wasm：
    - `ffmpeg -af atempo=…`
    - Signalsmith 的 `cmd/`
    - SoundTouch 的 `soundstretch`
  - 重點聽三件事：子音的瞬態、呼吸聲、立體聲定位。
- **CPU**：用 wasm build 在 Worker 內跑 48k 與 192k 的立體聲，量測即時倍數；手機（iOS Safari、Android Chrome）也要跑。
- **體積**：在 #10 的 build pipeline 中比較開啟與關閉 libavfilter 加 atempo 的 wasm 大小差異。
- **AudioWorklet 內載入 wasm**：只有在將來改用 worklet 端的 stretcher 時才需要查證，v1 不需要。
