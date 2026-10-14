# wasm 軟體解碼（dav1d）的效能與打包

> Research ticket：[#20](https://github.com/mocukie/kikoeru-player/issues/20)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)），為決策 ticket [#21](https://github.com/mocukie/kikoeru-player/issues/21) 準備資料。
> 實測日期：2026-10-13。對象：libav.js master `c05a676`（= `v6.10.9.0` 加上 dav1d 的兩個 commit）內建的 dav1d 1.5.4，經 FFmpeg 9.0 的 `libdav1d` wrapper 呼叫。
> 標記：**[實測]** 本次在瀏覽器或本機量到；**[原始碼]** 對照 libav.js／dav1d／FFmpeg／WebKit 原始碼；**[已查證]** 對照其他一手來源；**[推論]** 由實測與來源推得；**[未測]** 本次無法測。
> 原始數據在 branch 的 `research/wasm-video-decode-spike/data/`，表格可用 `node summarize.mjs data` 重新產生。

## 0. 環境與方法

- **機器**：AMD EPYC 7K62（Zen 2，VM 32 vCPU，Linux）。所有瀏覽器數字都在官方 Docker image `mcr.microsoft.com/playwright:v1.63.0-noble` 內量：Chromium 153.0.8010.12、WebKit 26.6（WPE，Linux）、Firefox 155.0；**headless、沒有 GPU**。
  - **Linux 上的 Playwright WebKit 不等於 Safari**：JavaScriptCore 的 wasm 編譯器相同，但 VideoFrame 的後端是 GStreamer，Apple 平台走 CoreVideo（§6）；CPU 也是 x86。
  - 單執行緒的數字代表「一顆 Zen 2 伺服器核心」，不是手機。手機的推算見 §8，實機項目見 §10。
- **build**：在釘 digest 的 `emscripten/emsdk:6.0.5` 內，以 libav.js commit `c05a676`、FFmpeg 9.0、dav1d 1.5.4 build（`build.sh`）。套上 #10／#17／#18 的三個 0BSD wrapper patch，與正式 variant 一致。
  - `kikoeru-af`：ADR-0003 的主 variant（#10 的清單加 avi、aiff、ac3、eac3）。
  - `kikoeru-afv`：`kikoeru-af` 加 `decoder-libdav1d`（選項 A：dav1d 放進主 variant）。
  - `kikoeru-dav1d`：只有 `avcodec` 加 `decoder-libdav1d`（選項 B：需要時才載入的獨立 wasm）。
  - 編譯選項（flavor）：`oz`＝libav.js 預設的 `OPTFLAGS=-Oz`；`o3`＝`-O3`；`o3s`＝`-O3 -msimd128`（全部，含 FFmpeg 與 link）；`mix`＝FFmpeg 與 link 維持 `-Oz`，只有 dav1d 用 `-O3 -msimd128`（改 `mk/libdav1d.mk` 的 `c_args`）。
  - 每個組合另外 link 一份**不開 Asyncify**（`noasy`）的版本，以及 `thr`（`-pthread`）版本。
- **量法**（`t-decode.mjs`）：比照 Engine，在 module Worker 內以 `noworker`（direct 模式）載入 libav.js。先用 `kikoeru-af` 把整個 MP4 demux 成封包（不計時），再交給指定的 dav1d wasm，用 `_sync` 函式逐封包 `avcodec_send_packet`／`avcodec_receive_frame` 並計時。
  - **decode-only fps**：frame 數 ÷ 解碼呼叫的總時間（不含取出與 VideoFrame）。
  - **即時倍數**：decode-only fps ÷ 內容 fps。
  - **預先解碼量（preroll）**：使「第 k 個 frame 解完的時間 ≤ D ＋ k／fps」對所有 k 成立的最小 D。平均跟得上、但個別封包很慢時，D 就是播放前要先解好的量；平均跟不上時，D 會隨片長一直增加。
  - 多執行緒（`thr`）的 dav1d 是非同步輸出，改用 wall-clock fps。
  - 完整路徑（`m-pipeline.mjs`）：Worker 解碼 → 從 wasm heap 取出成緊密的 I420（10-bit 在 JS 右移 2 位轉 8-bit）→ `new VideoFrame` → transfer 給主執行緒 → `drawImage` 到 1280×720 的 2D canvas。不限速，在途 frame ≤ 4，每 10 張做一次 1px `getImageData`，沿用 #17 的量法。
  - 原生對照（`native-bench.sh`）：同一台機器、同一批檔案，dav1d 1.5.4 CLI，`asm`（AVX2 等手寫組語）與 `--cpumask 0`（只用 C）。
- **媒體**（`gen-media.sh`，不進 git）：Blender 開放影片 Big Buck Bunny 1080p30（動畫）與 Tears of Steel（實拍加 CG，2.4:1，24 fps）各取 20 秒，用 FFmpeg 7.1（Lavc 61.19）的 libaom-av1 編碼：`-usage good -cpu-used 6 -row-mt 1`、GOP 4 秒、1-pass 目標 bitrate、MP4。實際 bitrate 與目標相符（例如 `bbb-1080-8-2M` 是 2.09 Mbps，`tos-800-8-3M` 是 3.0 Mbps）。

| 檔名 | 內容 | 解析度 | fps | bit depth | bitrate |
|---|---|---|---|---|---|
| `bbb-1080-{8,10}-{2M,6M}` | BBB 動畫 | 1920×1080 | 30 | 8／10 | 2／6 Mbps |
| `bbb-720-{8,10}-{1M,3M}` | BBB 動畫 | 1280×720 | 30 | 8／10 | 1／3 Mbps |
| `tos-800-{8,10}-3M` | ToS 實拍 | 1920×800 | 24 | 8／10 | 3 Mbps |
| `tos-534-8-1.5M` | ToS 實拍 | 1280×534 | 24 | 8 | 1.5 Mbps |
| `bbb-1080-8-2M-tiles` | 同上，2×2 tiles | 1920×1080 | 30 | 8 | 2 Mbps |
| `tos-800-8-3M-grain` | 同上，film grain synthesis（`-denoise-noise-level 10`） | 1920×800 | 24 | 8 | 3 Mbps |

- 每個量測只跑一次（每次 480–600 個 frame）。三個瀏覽器的同組數字差距多在 ±10% 內，可以當作重複性的參考。

## 1. libav.js 的 dav1d（「2026-08 加入的 dav1d variant」）

**存在，但只在 master，沒有任何 release 含它** [已查證]。

- PR [#108「Add dav1d AV1 decoder variant」](https://github.com/Yahweasel/libav.js/pull/108)（外部貢獻者，2026-08-20 開，**2026-08-30 merge**），兩個 commit：`f8f1e84`（新增）、`430ae83`（整理：改名為 `decoder-dav1d`、對齊其他 library 的 build 規則）。之後 `c05a676`（2026-08-31）在 CI 加了 `apt install meson`，該 commit 的 CI「Build and test」通過。
- 最新的 tag 是 `v6.10.9.0`（2026-08-18，早於 PR），npm 的 `libav.js` 最新版也是 6.10.9，`@libav.js/variant-decoder-dav1d` 不存在（npm 404）。所以「可以直接用」的意思只能是：**釘 master 的 commit 自己 build**。我們本來就自己 build（ADR-0001），差別只在釘 commit 而不是 tag。`v6.10.9.0..c05a676` 只有 dav1d 與 CI 的改動，產物版本字串仍是 `6.10.9.0`。
- 維護者在 PR 裡表示 dav1d「應該是預設的 AV1 decoder，而不是 AOM」。README 對既有的 `av1-opus`（libaom）variant 仍寫著「AV1 在 WebAssembly 即使開 threads 也慢到實際上無法使用」，這句話指的是 libaom。

**內容** [原始碼，`c05a676`]：

| 項目 | 內容 |
|---|---|
| 預建 config | `configs/configs/decoder-dav1d`：`["avcodec","parser-av1","decoder-libdav1d"]`，`noAll`（不進 release 的 variant 清單） |
| fragment | `configs/fragments/decoder-libdav1d`：`--enable-libdav1d --enable-decoder=libdav1d`，**另外固定開 `av1_metadata` 與 `extract_extradata` 兩個 bsf**；`license.js` 帶 dav1d 的 BSD-2 條文 |
| dav1d 版本 | `mk/libdav1d.mk`：`DAV1D_VERSION=1.5.4`，從 code.videolan.org 下載 tarball（**不驗證 hash**，跟其他依賴一樣，要自己先放好並核對 sha256） |
| dav1d 的 build | meson（`mk/emscripten.meson.cross`），`--buildtype=release -Dc_args="$(OPTFLAGS) …" -Denable_asm=false`，tools／tests 關閉；`base` 與 `thr` 兩個 target 各 build 一次 |
| patch | `patches/dav1d.diff`：emscripten 時不加 `threads` 依賴、不對 wasm 強加 atomics flag（避免非 threaded build 帶進 pthread flag） |

- **對我們的意義**：可以直接把 `"decoder-libdav1d"` 加進自訂 variant 的 fragment 清單（本次的 `kikoeru-afv`、`kikoeru-dav1d` 就是這樣 build），不需要 fork 或另寫 build 規則。#10 的 build 環境只要多裝 `meson`、`ninja-build`。
- **兩個要自己處理的地方**：
  1. dav1d 的編譯選項跟著全域的 `OPTFLAGS`（預設 `-Oz`），而且 `-Denable_asm=false`。速度差很多（§3），要用 `-O3 -msimd128` 就得改 `mk/libdav1d.mk` 一行（或整個 variant 改 `OPTFLAGS`）。這屬於 build 設定，不必改 libav.js 的程式。
  2. libav.js 的 `base` target 一律連結 emfiberthreads（用 fiber 模擬 pthread），dav1d 在非 threaded build 也能呼叫 `pthread_create`。FFmpeg 的 `libdav1d` wrapper 以 `AVCodecContext.thread_count`（預設 1）決定 `n_threads`，所以預設就是單執行緒；**不可以把 `threads` 設成 0（auto）或大於 1**，否則在 fiber 上跑多個「執行緒」只會更慢 [原始碼：`libavcodec/libdav1d.c` L206–229；libav.js `docs/API.md` 對 emfiberthreads 的說明]。
- **dav1d 沒有 wasm 的手寫 SIMD**：dav1d 1.5.4 與 master 的 `src/` 只有 `arm`、`x86`、`ppc`、`loongarch`、`riscv` 的組語，沒有 wasm；VideoLAN GitLab 上與 wasm 有關的 MR 只有 CI 與 build 修正（!1239、!1491、!1492），2019 年的 emscripten 最佳化 MR !606 已關閉 [已查證]。所以 wasm 的 SIMD 只能靠編譯器 auto-vectorization（`-msimd128`）。ogv.js 的 dav1d build 正是用 `-O3 -msimd128`、`-Denable_asm=false`，另外只開 8-bit（`-Dbitdepths=['8']`）[已查證：ogv.js `buildscripts/compileDav1dWasm.sh`、`dav1d-wasm-cross.txt`]。本次確認 `o3s` 的 wasm 裡有約 1.29 萬個 SIMD 指令，`oz`／`o3` 是 0 [實測：`wasm-dis` 計數]。

## 2. 單執行緒的速度

**Engine 現在的條件（Worker、Asyncify、libav.js 預設 `-Oz`）下，1080p 在這台機器就跟不上 30 fps；把 dav1d 改用 `-O3 -msimd128` 後，1080p 動畫勉強可以，實拍不行，720p 有 2–3 倍餘裕** [實測]。

decode-only fps（Chromium／WebKit／Firefox），括號內是即時倍數的範圍：

| 檔案 | 內容 fps | `oz`（Engine 條件） | `o3s-noasy`（最佳） | `o3s-noasy` 的 preroll（ms） |
|---|---|---|---|---|
| bbb-1080-8-2M | 30 | 24.7／22.8／23.0（0.76–0.82×） | 43.4／43.1／46.0（1.44–1.53×） | 251–266 |
| bbb-1080-8-6M | 30 | 21.9／20.7／20.5（0.68–0.73×） | 36.8／36.6／37.2（1.22–1.24×） | 307–326 |
| bbb-1080-10-2M | 30 | 21.3／19.8／21.2（0.66–0.71×） | 37.2／36.5／38.1（1.22–1.27×） | 277–299 |
| bbb-1080-10-6M | 30 | 19.9／18.6／19.5（0.62–0.66×） | 33.2／33.6／33.0（1.10–1.12×） | 315–334 |
| bbb-720-8-1M | 30 | 53.2／49.1／49.2（1.64–1.77×） | 89.1／92.2／97.8（2.97–3.26×） | 112–123 |
| bbb-720-8-3M | 30 | 44.5／41.7／41.8（1.39–1.48×） | 71.7／73.4／76.1（2.39–2.54×） | 140–156 |
| bbb-720-10-1M | 30 | 47.5／44.0／46.3（1.47–1.58×） | 77.5／82.2／84.6（2.58–2.82×） | 118–132 |
| bbb-720-10-3M | 30 | 42.3／39.5／41.2（1.32–1.41×） | 67.3／69.3／69.4（2.24–2.31×） | 142–160 |
| tos-800-8-3M | 24 | 13.4／12.5／12.2（0.51–0.56×） | 23.5／22.8／23.7（0.95–0.99×） | 551–1311（跟不上） |
| tos-800-10-3M | 24 | 12.8／11.8／11.9（0.49–0.53×） | 22.2／22.1／20.7（0.86–0.93×） | 1813–3302（跟不上） |
| tos-534-8-1.5M | 24 | 29.8／27.7／27.2（1.13–1.24×） | 46.6／47.9／50.8（1.94–2.11×） | 73–81 |
| bbb-1080-8-2M-tiles | 30 | 24.3／22.6／22.6（0.75–0.81×） | 43.4／42.4／45.5（1.41–1.52×） | 255–262 |
| tos-800-8-3M-grain | 24 | 11.4／10.8／10.6（0.44–0.47×） | 18.6／17.9／18.7（0.75–0.78×） | 5734–6911（跟不上） |

- **三個引擎的差距在 10% 內**，JavaScriptCore 並沒有特別慢。
- **內容比解析度更重要**：同樣「1080p 級」，實拍的 ToS（1920×800，像素只有 BBB 的 74%）每個 frame 比 BBB 動畫慢約 1.8 倍。bitrate 從 2 到 6 Mbps 慢 15–18%；10-bit 比 8-bit 慢 10–15%。
- **2×2 tiles 對單執行緒沒有影響**（只影響多執行緒，§4）。
- **film grain synthesis 很貴**：同一段 ToS，帶 grain 參數的檔案慢 20%，關掉 grain 合成（`export_side_data=film_grain`，由 decoder 輸出參數、不套用）就回到 22.4–23.0 fps（§7）。
- **封包的耗時兩極化**：libaom 的 alt-ref 結構讓少數 temporal unit 很貴。`bbb-1080-8-2M` 的 `o3s-noasy` 每個封包 p50 7 ms，p95 94–100 ms，max 306–321 ms；`oz` 的 max 達 517–568 ms。所以「平均跟得上」還不夠，**播放前要先解好約 250–330 ms（1080p）或 110–160 ms（720p）**，否則遇到 alt-ref 就掉格。
- **跟原生 dav1d 比**（同一台機器，單執行緒）[實測：`data/native.tsv`]：

| 檔案 | 原生 asm（AVX2） | 原生 C（`--cpumask 0`） | wasm `o3s-noasy`（Chromium） | wasm `oz`（Chromium） |
|---|---|---|---|---|
| bbb-1080-8-2M | 200 fps | 62 fps | 43 fps | 25 fps |
| bbb-1080-10-6M | 106 fps | 34 fps | 33 fps | 20 fps |
| bbb-720-8-1M | 457 fps | 134 fps | 89 fps | 53 fps |
| tos-800-8-3M | 131 fps | 36 fps | 24 fps | 13 fps |

  wasm 加 auto-vectorization 大約是原生純 C 的 65–97%，但只有原生手寫組語的 18–31%。換句話說，**原生 dav1d 的速度大多來自手寫 SIMD，wasm 拿不到**，不能直接用原生 dav1d 的公開數據推估 wasm（§8）。

## 3. 編譯選項、SIMD 與 Asyncify

**影響最大的是 `-msimd128`；Asyncify 只差幾個百分點** [實測：`data/flavors.json`、`data/mix.json`]。

decode-only fps（Chromium／WebKit／Firefox）：

| 檔案 | `oz` | `oz-noasy` | `o3` | `o3-noasy` | `o3s` | `o3s-noasy` |
|---|---|---|---|---|---|---|
| bbb-1080-8-2M | 24.5／22.7／22.9 | 25.8／24.1／24.0 | 26.9／24.9／25.8 | 27.8／25.7／26.3 | 41.7／40.6／44.3 | 43.7／43.0／45.6 |
| bbb-1080-10-2M | 21.3／19.6／21.3 | 21.8／20.3／21.4 | 23.6／20.4／21.4 | 24.2／21.0／21.7 | 35.6／34.9／36.9 | 37.1／36.8／38.0 |
| bbb-720-8-1M | 53.3／49.1／49.4 | 55.9／51.7／51.6 | 58.0／53.4／55.5 | 60.1／55.1／56.2 | 86.0／87.3／95.5 | 89.5／92.6／97.7 |
| tos-800-8-3M | 13.4／12.4／12.3 | 14.3／13.4／13.0 | 15.2／13.9／14.0 | 15.7／14.3／14.3 | 22.5／21.5／22.9 | 23.5／22.8／23.7 |

（每格一次量測。）

- **Asyncify**：同一份物件檔，拿掉 Asyncify 只快 1–8%。原本擔心 dav1d 的 DSP 全是 function pointer 呼叫、會讓 Asyncify 把整個解碼路徑 instrument 起來，實際影響很小。這跟 #17 量到音訊「解碼＋filter」慢 13–25% 相比還更小。
- **`-O3`**：比 `-Oz` 快 5–10%。
- **`-msimd128`**：在 `-O3` 之上再快 50–70%，是 `oz` 的 1.7–1.95 倍。所有目標瀏覽器都支援 wasm SIMD（Chrome 91、Firefox 89、Safari 16.4）[已查證：MDN browser-compat-data `webassembly/fixed-width-SIMD`；WebKit「Safari 16.4」release notes]，不需要另做非 SIMD 的 fallback。
- **mix（只有 dav1d 用 `-O3 -msimd128`，FFmpeg 其他部分與 link 維持 `-Oz`）就拿到幾乎全部的好處**：

| 檔案 | `kikoeru-afv` oz（主 variant，Asyncify） | `kikoeru-afv` mix（主 variant，Asyncify） | `kikoeru-dav1d` mix-noasy（獨立 wasm） | `kikoeru-dav1d` o3s-noasy |
|---|---|---|---|---|
| bbb-1080-8-2M | 24.5／22.6／23.0 | 41.8／40.9／44.4 | 43.3／42.7／45.8 | 43.7／43.0／45.6 |
| bbb-1080-10-2M | 21.1／19.7／21.3 | 35.7／34.5／36.8 | 37.2／36.2／38.2 | 37.1／36.8／38.0 |
| bbb-720-8-1M | 52.8／49.1／49.2 | 85.6／87.2／94.7 | 89.1／92.3／98.0 | 89.5／92.6／97.7 |
| tos-800-8-3M | 13.5／12.4／12.3 | 22.4／21.7／22.8 | 23.1／22.5／23.8 | 23.5／22.8／23.7 |

  主 variant 內的 dav1d（mix、Asyncify）是最佳組合的 94–97%。也就是說，**選項 A 與選項 B 的速度差只有 3–6%**，選擇要看體積、載入時機與執行緒配置（§5、§9）。

## 4. wasm threads

**開 threads 很有效：2 threads 約 1.6–1.75 倍，4 threads 約 2–2.6 倍（有 tiles 時 3.1 倍），但前提是 `crossOriginIsolated`** [實測：`data/threads.json`]。

`kikoeru-dav1d` o3s-noasy 的 `thr` build，頁面與所有 script 都帶 COOP `same-origin`／COEP `require-corp`，libav.js direct 模式，`thread_count = N`（dav1d 依 N 自動決定同時解幾個 frame：2–4 threads 為 2 個、5–9 為 3 個 [原始碼：dav1d `src/lib.c` 的 `fc_lut`]），pthread pool = N＋1。wall-clock fps（Chromium／WebKit／Firefox）：

| 檔案 | 1 | 2 | 3 | 4 | 6 | 8 |
|---|---|---|---|---|---|---|
| bbb-1080-8-2M | 43.6／43.3／45.1 | 71.0／71.2／72.0 | 86.9／90.0／90.8 | 92.9／96.8／97.7 | 130.5／136.4／137.9 | 131.1／136.8／134.3 |
| bbb-1080-10-6M | 33.2／33.6／32.2 | 52.6／53.3／50.8 | 62.7／64.5／68.4 | 67.4／67.5／65.9 | 90.9／93.8／89.0 | 87.8／91.0／89.1 |
| bbb-1080-8-2M-tiles | 43.4／42.7／44.7 | 76.6／73.9／78.2 | 109.5／105.1／113.9 | 133.8／134.0／139.4 | 199.7／203.2／202.8 | 223.2／242.1／244.9 |
| tos-800-8-3M | 23.5／22.8／23.4 | 40.5／40.2／40.8 | 52.7／52.4／55.5 | 60.0／60.2／62.1 | 88.5／90.3／90.9 | 89.9／91.0／91.6 |

- 三個引擎（含 WebKit）的 threads 都能用，scaling 也一樣。
- 沒有 tiles 時，scaling 在 frame 數換檔處跳一階（4 → 6 threads 從 2 個 frame 變 3 個），4 threads 之後要靠 tiles 才繼續變快。
- **要幾條 thread 才即時**（這台機器、`o3s`）：BBB 1080p 1 條就夠；實拍 ToS（1920×800、24 fps）要 2 條（40 fps，1.7 倍）；10-bit 6 Mbps 的 1080p 2 條有 1.75 倍。手機核心慢多少，就要再乘上去（§8）。
- **測試機有 32 核，threads 之間沒有互搶**。手機只有 2 個效能核心加 4 個節能核心，第 3 條以後會落到節能核心，scaling 會比上表差 [推論]。

**發現的問題：threaded build 在 direct 模式下，memory grow 之後 JS 端的 heap view 不會更新** [實測]。

- 第一輪量測（`data/threads-run1.json`）中，Chromium 的 2、6、8 threads 都丟出 `RangeError: offset is out of bounds`（`ff_set_packet` → `Module.HEAPU8.set`）。Node 也能重現，`oz`、`o3s`、有無 Asyncify 都一樣。
- 原因：`thr` build 的 memory 是 `SharedArrayBuffer`，dav1d 的 worker thread 呼叫 `malloc` 讓 memory grow 時，只有該 thread 的 view 會更新；libav.js 的 JS 程式直接用 `Module.HEAPU8`，在呼叫端 thread 看到的仍是舊長度。emsdk 6.0.5 產生的 glue 裡沒有 `GROWABLE_HEAP_*` 的檢查 [原始碼：產物 `updateMemoryViews`]。
- 繞過方式：量測時把 shared memory 的初始大小開到 512 MiB（`t-decode.mjs` 包一層 `WebAssembly.Memory`），之後全部通過，表內是第二輪的數字。正式做法可以是 build 時設較大的 `INITIAL_MEMORY`（thread 版才需要）、每次呼叫前比對 `buffer` 並重建 view，或者向 upstream 回報。
- 另一個觀察：pthread Worker 的 script URL 寫錯（改檔名但沒改 glue 內的檔名）時，WebKit 不會報錯而是一直卡住，Chromium 則是 `worker error`。threaded build 的初始化要有 timeout。

**`crossOriginIsolated` 的前提** [已查證]：

- wasm threads 需要 `SharedArrayBuffer`，也就是頁面必須 cross-origin isolated。Safari 15.2 起支援 COOP／COEP 並重新開放 `SharedArrayBuffer` 與 wasm threads [WebKit「New WebKit Features in Safari 15.2」；BCD `webassembly/threads-and-atomics`：Chrome 74、Firefox 79、Safari 15.2]。
- COEP `credentialless` 在 Safari 仍不支援（BCD：`safari: false`），所以在 Safari 上要 isolation，就只能全站送 `require-corp`。這正是 ADR-0001 否決 SAB 的理由。
- 本次的 harness 必須讓**所有** response（頁面、Worker script、pthread Worker 的 glue、wasm、媒體）都帶 COOP／COEP／CORP，才能在三個引擎都取得 isolation。

## 5. 打包：體積、build 時間與 CI

**體積** [實測：`data/sizes.md`；raw／gzip -9／brotli q11，KiB；「合計」= wasm＋glue（`.wasm.mjs`／`.thr.mjs`）＋frontend（`.mjs`）的 brotli]：

| 組合 | wasm raw | wasm brotli | glue brotli | 合計 brotli | 與現行主 variant 相比 |
|---|---|---|---|---|---|
| `kikoeru-af` oz（現行主 variant） | 2038.0 | 669.6 | 48.2 | 723.7 | — |
| A：`kikoeru-afv` oz（libav.js 預設） | 2597.4 | 833.3 | 48.6 | 887.9 | **+164.2**（每個使用者都要下載） |
| A：`kikoeru-afv` mix（dav1d 用 `-O3 -msimd128`） | 2791.1 | 870.5 | 48.6 | 925.1 | **+201.4** |
| B：`kikoeru-dav1d` oz（Asyncify） | 1069.5 | 330.2 | 39.9 | 375.4 | 主 variant 不變；Safari 遇到 AV1 才另外下載 |
| B：`kikoeru-dav1d` oz-noasy | 792.4 | 290.1 | 38.2 | 333.6 | 同上 |
| B：`kikoeru-dav1d` mix-noasy | 974.4 | 324.5 | 38.2 | 368.0 | 同上 |
| B：`kikoeru-dav1d` o3s-noasy | 1061.5 | 343.9 | 38.3 | 387.5 | 同上 |
| thr：`kikoeru-dav1d` mix-noasy | 1001.7 | 327.3 | 41.5 | 368.8 | 另一組產物（frontend 共用） |

- **選項 A（放進主 variant）**：dav1d 本身只多 164–201 KiB（brotli），因為 libavcodec／libavutil 與 emscripten runtime 已經在主 variant 裡。但 Chromium 與 Firefox 用 WebCodecs 解 AV1，所以這些位元組只有 Safari 用得到。主 variant 的 raw 大小從 2.0 MiB 變成 2.7 MiB，`compileStreaming` 的時間與每個 instance 的 code 記憶體也跟著變大 [推論；#17 量到 WebKit 編譯 1.9 MiB 約 36 ms]。
- **選項 B（獨立 wasm，需要時才載入）**：合計約 334–388 KiB，比 A 的增量多約 170 KiB，因為要再帶一份 libavcodec 核心、libavutil 與 emscripten runtime。好處是：
  - 非 Safari、非 AV1 的使用者完全不用下載。
  - 不需要 Asyncify（decoder 不做 I/O），可以少 1–8% 的時間（§3）與約 40 KiB。
  - 可以放在自己的 Worker（§7 的 Worker 佔用問題，見「對 #21 的含意」）。
  - 編譯選項可以跟主 variant 分開（主 variant 維持 `-Oz`）。
  - 代價：多一個 instance 的 wasm heap（libav.js 預設 24 MiB 起跳，1080p 解碼時會再 grow；本次沒有量 dav1d 的 heap 峰值）以及 WebKit 上每個 instance 30–100 MiB 的 PSS（#17）；packet 要從 demux 的 instance 複製到 decoder 的 instance（每個封包一次 JS 複製，1080p 2 Mbps 約 8 KiB／frame，可以忽略）[推論]。
- **只開 8-bit**（`-Dbitdepths=['8']`，ogv.js 的做法）可以再小一些，但 10-bit AV1 很常見（例如動畫的 AV1 重編碼），本次沒有 build 這個組合 [未測]。

**build 時間**（模擬 private repo 的 GitHub runner：`--cpus=2`、`make -j2`、每個組合一份全新的樹，含 emfiberthreads、dav1d 的 meson build、FFmpeg configure 與 compile、link；`npm ci` 不計）[實測：`data/build-times.tsv`]：

| 組合 | 秒 | 說明 |
|---|---|---|
| `kikoeru-af` wasm | 110 | 現行（#10 量到 106 s，這次多了 avi／aiff／ac3／eac3） |
| `kikoeru-afv` wasm（A） | 126 | +16 s（dav1d 的 compile） |
| `kikoeru-dav1d` wasm（B，獨立） | 102 | 另一個 variant，CI 上與主 variant 平行或依序；依序時合計 212 s |
| `kikoeru-dav1d` wasm＋thr | 141 | thr 要另外 configure／compile 一份 FFmpeg 與 dav1d（`-pthread`），+39 s |
| `kikoeru-afv` wasm＋thr | 190 | 主 variant 做 thr 版：+64 s（＋51%） |

- **threaded build 對 CI 的影響**：
  - build 時間：主 variant 加 thr 約多一半；只對獨立的 dav1d 做 thr 只多 39 s。都還在 #10「一次乾淨 build 約 3 分鐘」的量級，時間不是問題。
  - **產物**：多一組 `.thr.wasm`＋`.thr.mjs`（獨立 dav1d 約 369 KiB brotli），Release 與 `sources/`、license header 的檢查都要涵蓋。
  - **測試矩陣**才是主要成本：thr 只有在 `crossOriginIsolated` 頁面才會被選用，E2E 要多一個「server 帶 COOP／COEP／CORP」的 Playwright project，並且三個引擎都要跑；還要測 isolation 不成立時的退回路徑。本次就遇到兩個只在 thr 才有的問題：memory grow 後 heap view 失效（§4）、pthread Worker 載入失敗時 WebKit 卡住不報錯。
  - 與 ADR-0001 的比較：ADR-0001 否決的是「JSPI＋Asyncify 雙 build」，那是把**整個主 variant** 做成兩份。若只對**獨立的 dav1d wasm** 做 thr 版，翻倍的只有 dav1d 這一小塊的產物與「Safari＋AV1＋isolated 頁面」這一條測試路徑，範圍小得多 [推論]。

## 6. 由 I420 buffer 建立 VideoFrame（以 WebKit 為主）

**8-bit I420 很便宜；10-bit 不能直接建，WebKit 與 Firefox 都要先轉成 8-bit，而在 JS 轉很貴** [實測：`data/vfcost.json`、`data/pipeline.json`]。

`new VideoFrame(buffer, init)` 的同步耗時（Worker 內，ms p50／p95；WebKit 的計時解析度是 1 ms）：

| 尺寸 | 格式 | Chromium | WebKit | Firefox |
|---|---|---|---|---|
| 1280×720 | I420 | 0.1／0.2 | 0／1 | 1／1 |
| 1280×720 | I420＋`transfer` | 0／0.1 | 0／1 | 0／1 |
| 1280×720 | NV12 | 0.1／0.2 | 0／1 | 1／1 |
| 1280×720 | I420P10 | 0.2／0.4 | **TypeError** | **NotSupportedError** |
| 1920×1080 | I420 | 0.2／1.5 | 1／1 | 1／2 |
| 1920×1080 | I420＋`transfer` | 0／0.1 | 1／1 | 1／2 |
| 1920×1080 | NV12 | 0.2／0.4 | 0／1 | 1／2 |
| 1920×1080 | I420P10 | 0.6／3.4 | **TypeError** | **NotSupportedError** |

在 JS 從 wasm heap 取出（模擬 dav1d 的 stride 對齊）的成本，ms p50：

| 尺寸 | 8-bit：逐列 `set` 成緊密 I420 | 10-bit：逐 sample 右移 2 位轉 8-bit |
|---|---|---|
| 1280×720 | 0.6／1／0（Chromium／WebKit／Firefox） | 4.5／4／3 |
| 1920×1080 | 1.2／1／1 | 10.1／9／10 |

- **WebKit 的 10-bit**：buffer 建構子遇到高 bit depth 格式，先檢查 `webCodecsHighBitDepthEnabled`，關閉時丟 `TypeError`；就算打開，switch 也只實作 NV12、RGBA／RGBX、BGRA／BGRX、I420、I420A，其餘丟 `NotSupportedError`。這個 pref 是 `testable`，預設 false [原始碼：WebKit `WebCodecsVideoFrame.cpp` 的 `create(…, BufferInit)`、`UnifiedWebPreferences.yaml`]。所以 Safari 上 10-bit AV1 一定要轉成 8-bit 才能交給 `VideoFrame`。
- **Firefox 155** 也不接受 I420P10 的 buffer（`NotSupportedError`），Chromium 可以。
- **Safari 的 I420 會再轉一次**：Cocoa 上 `VideoFrame::createI420` 呼叫 libwebrtc 的 `createPixelBufferFromI420Buffer`，建一個 NV12 的 `CVPixelBuffer`（沒有指定 IOSurface 屬性）再把 I420 複製並交錯成 NV12 [原始碼：`VideoFrameCV.mm`、`webkit_sdk/WebKit/WebKitUtilities.mm`]。Linux WPE 的數字量不到這段，實機要另外量。直接給 NV12 理論上可以省掉交錯，但交錯只是換到 wasm／JS 端做 [推論]。
- **完整路徑**（Worker 解碼 → 取出 → VideoFrame → transfer → 主執行緒 `drawImage` 到 1280×720 canvas，不限速）：

| 檔案 | flavor | pipeline fps（Chromium／WebKit／Firefox） | 取出 ms p50 | VideoFrame ms p50 | drawImage ms p50 |
|---|---|---|---|---|---|
| bbb-1080-8-2M | oz | 23.2／21.2／21.3 | 1.4／2／1 | 0.5／1／1 | 7.1／4／6 |
| bbb-1080-8-2M | o3s-noasy | 39.3／38.0／39.7 | 1.4／2／1 | 0.5／1／1 | 7.0／3／6 |
| bbb-1080-10-2M | oz | 16.8／16.8／17.3 | 11.3／7／9 | 0.5／1／1 | 7.1／4／6 |
| bbb-1080-10-2M | o3s-noasy | **25.3／27.8／26.8** | 11.3／7／9 | 0.5／1／1 | 7.2／4／7 |
| bbb-720-8-1M | oz | 50.2／45.3／46.1 | 0.6／1／1 | 0.2／0／1 | 2.3／2／2 |
| bbb-720-8-1M | o3s-noasy | 79.5／81.3／85.7 | 0.7／1／1 | 0.2／0／0 | 2.3／2／2 |
| bbb-720-10-1M | oz | 37.3／37.6／37.4 | 5.1／3／4 | 0.2／0／1 | 2.4／3／2 |
| bbb-720-10-1M | o3s-noasy | 53.8／61.1／58.9 | 5.1／3／4 | 0.2／0／0 | 2.3／2／2 |

  - 8-bit 的取出加 VideoFrame 每張 1.5–3 ms，約佔 1080p 解碼時間的 7–10%；`drawImage` 在主執行緒，不佔 Worker。
  - **10-bit 的 JS 轉換每張 7–11 ms（1080p）**，讓 `o3s` 的 1080p 10-bit 從 decode-only 37 fps 掉到 25–28 fps，**從可即時變成跟不上**。這段應該放進 wasm 做（C 迴圈加 `-msimd128`，或在 dav1d wasm 內加一個小的轉換函式），預期可降到接近 8-bit 取出的 1–2 ms [推論，未實作]。用 libswscale 也可以，但 variant 要多帶 swscale。
  - transfer 延遲 p50 ≤ 1 ms（Chromium 偶爾 2.5 ms），與 #17 相同。WebKit 的 1px readback 約 3–4 ms，也與 #17 相同（軟體繪製）。

## 7. 跟不上時能省什麼：掉格、grain、seek

**AV1 的掉格幾乎省不到解碼時間；能省的是 film grain 與輸出端** [實測：`data/skip.json`；原始碼]。

- **只解 reference frame**：FFmpeg 的 `skip_frame=noref` 對應 dav1d 的 `DAV1D_DECODEFRAMETYPE_REFERENCE`。但它只在 `libdav1d_init` 讀一次，執行中要切換就得關掉重開 decoder，而重開只能從 keyframe 開始 [原始碼：FFmpeg 9.0 `libavcodec/libdav1d.c` L237–242；dav1d `include/dav1d/dav1d.h`]。

| 檔案 | 一般（frame 數／fps） | `skip_frame=noref`（frame 數／fps，Chromium／WebKit／Firefox） |
|---|---|---|
| bbb-1080-8-2M | 600／43.4 | 582／42.8、42.0、45.2 |
| bbb-1080-10-6M | 600／33.2 | 587／32.7、33.1、32.4 |
| tos-800-8-3M-grain | 480／18.6 | 477／18.5、17.9、18.7 |

  libaom（good、alt-ref）的檔案裡 **97–99% 的 frame 都會被參照**，跳過 non-reference frame 只少了 0.6–3% 的 frame，速度幾乎沒變。AV1 的 inter frame 一般都會更新參考緩衝區，不像 H.264 常見的 non-reference B-frame，所以「跟不上就丟 frame」在 AV1 只能丟**輸出**（不取出、不建 VideoFrame、不畫），省下的是 §6 的 1.5–3 ms（8-bit）或 7–11 ms（10-bit 的 JS 轉換），不是解碼本身 [推論，依實測]。
- **film grain**：`tos-800-8-3M-grain` 關掉 grain 合成（`export_side_data=film_grain`，decoder 只輸出參數）後，從 18.6 fps 回到 22.4–23.0 fps（快 20–24%），與沒有 grain 的同一段（23.5 fps）幾乎相同。代價是畫面少了 grain。這是唯一「執行中可以視情況放棄、又省得多」的項目，但它也只在 open 時讀取，切換需要重開 decoder [原始碼：`libdav1d.c` L219–222]。
- **解析度上限**：同一部片的 720p 版本比 1080p 快 2–2.4 倍（§2）。如果來源同時提供多種解析度，這是最有效的手段；kikoeru 的媒體通常只有一個檔案，Engine 能做的只有「判斷能不能播」[推論]。
- **seek 的代價**：精準 seek 要從前一個 keyframe 解到目標。本次的檔案 GOP 4 秒（實際 20 秒內有 9 個 keyframe），以 `o3s` 1080p 的 23–30 ms／frame 計算，最壞要先解約 120 個 frame，也就是 **2.8–3.6 秒**；`oz` 是 4.8–6 秒。實拍 ToS 是 96 個 frame × 42 ms ≈ 4 秒 [推論，依 §2 的 per-frame 時間]。用 keyframe 附近的快速 seek（只對齊到 keyframe）可以避開，但會與 ADR-0003「精準 seek」的定義衝突，要在 #21 決定。
- **Worker 被佔住的時間**：單執行緒時，一個 alt-ref 封包的解碼最多 300–370 ms（`o3s`，1080p；`oz` 517–644 ms）。這段期間呼叫端的 Worker 完全被佔住。如果 dav1d 跟音訊解碼、Range I/O 放在同一個 media Worker（ADR-0002 現在的分工），音訊的供料會被擋住同樣長的時間 [推論]。

## 8. 外部資料：Safari、iPhone／iPad

**適用範圍：Safari 上所有的 AV1 都會走 dav1d，不只是沒有硬體 decoder 的舊機** [已查證]。

- WebKit 的 `WebCodecsAV1Enabled` 是 `preview`，Cocoa 預設 false（GStreamer 才是 true）[原始碼：`UnifiedWebPreferences.yaml`，與 #5 的結論相同]。所以就算 iPhone 15 Pro（A17 Pro）以後與 M3 以後的 Mac 有 AV1 硬體 decoder，`VideoDecoder` 也不接受 `av01`。軟體解碼要覆蓋所有 Safari，包括最舊、最慢的支援機種。
- Safari 的 wasm 能力：SIMD 128 位 16.4 起 [WebKit「WebKit Features in Safari 16.4」：「In WebAssembly, we've added support for 128-bit SIMD.」]；threads（需 COOP／COEP）15.2 起；COEP `credentialless` 不支援；relaxed SIMD 只在 preview [BCD]。`VideoFrame` 建構子 16.4 起 [BCD]，10-bit buffer 格式見 §6。

**iPhone／iPad 的 dav1d 數據很少，而且都是原生、帶 NEON 組語** [已查證]：

- dav1d 0.2.0（2019）release notes：「achieves 1080p at 80fps on an iPhone XS」[VideoLAN GitLab，tag `0.2.0`]。未註明 thread 數與內容（dav1d 預設用全部核心）。
- J-B Kempf「dav1d 0.7.0 mobile focus」：Android 手機上 dav1d 可在 LITTLE 核心用 2 threads 解 Netflix 的 Chimera 樣本到 24 fps，結論是「It can decode 1080p with a couple of cores on mobile」。沒有 iOS 數據。
- SPIE 2022「Benchmarking and analysis of AV1 software decoding on Android devices」：dav1d 4 threads 在高中階 Android 手機可即時 1080p30 @ 4 Mbps，低階機 720p30 @ 2 Mbps（引自摘要）。
- **找不到 wasm 版 dav1d 在 iPhone／iPad（或任何手機）上的公開數據**。Brion Vibber 的 av1-demo（ogv.js 的 dav1d）README 寫著 Safari 只能單執行緒、沒有 wasm SIMD，「360p30 or 480p24 is about the limit on a fast Mac or iPad」。這是 Safari 16.4 之前、dav1d 早期版本的狀況，只能當下限參考。

**由本次數據推估手機（全部是 [推論]，要實機確認）**：

- 原生數據不能直接套用：本機上 wasm（`o3s`）只有原生組語的 18–31%（§2）。用 iPhone XS 原生 80 fps（多執行緒）乘上 0.2–0.3，單執行緒的 wasm 會遠低於 30 fps。
- 換個角度：本機一顆 Zen 2 伺服器核心，`o3s` 單執行緒 1080p 動畫有 1.1–1.5 倍、實拍不到 1 倍。近幾代 iPhone 的效能核心單執行緒通常比這顆核心快，但手機會降頻、Safari 也同時在畫 UI，而且 Engine 的音訊解碼與 filter 也要用 CPU。所以合理的預期是：**720p（含 10-bit）單執行緒在近幾代 iPhone／iPad 上可以即時；1080p 只有動畫類、低 bitrate 的內容有機會，實拍 1080p 單執行緒不行**。
- 舊機（例如 A12／A13 世代，iOS 18 仍支援）與節能模式下的 iPad，連 720p 實拍都可能不夠，需要實機數據才能決定門檻。

## 9. 授權與 NOTICE

**dav1d 是 BSD-2-Clause，只需要在發布物附上版權聲明、兩條條件與免責聲明；libav.js 的 build 已經自動把它放進 glue 的 license header** [已查證、實測]。

- dav1d 1.5.4 的 `COPYING`：「Copyright © 2018-2025, VideoLAN and dav1d authors. All rights reserved.」加 BSD-2 的兩條條件。第 2 條要求 binary 形式的散布「must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution」。README 說明刻意採用寬鬆授權，以便嵌入任何軟體。
- wasm 會編進去的 `src/*.c`、`src/*.h` 全部是同一份 BSD-2 header。另有其他授權的檔案只有 `src/ext/x86/x86inc.asm`（ISC）與 `include/compat/getopt.h`（tools 用），在 `-Denable_asm=false`、tools 關閉的 wasm build 都不會用到 [實測：逐檔比對 header]。
- libav.js 的 `decoder-libdav1d` fragment 帶 `license.js`，build 出來的 `*.wasm.mjs` 開頭 `/*! … */` 會多一段「dav1d:」與完整的 BSD-2 條文（`kikoeru-afv`、`kikoeru-dav1d` 都有，`kikoeru-af` 沒有）[實測]。跟 FFmpeg 的 LGPL header 一樣，**bundler 不能把它剝掉**（#10 的合規清單已有這一項）。
- 要加進 #10 的 NOTICE／合規清單的項目：
  - `NOTICE` 列出 dav1d 的版權聲明與 BSD-2 全文（Release tarball 與 App 的授權頁都要能看到）。
  - `sources/` 附上 `dav1d-1.5.4.tar.bz2`（BSD-2 不要求附原始碼，但 libav.js 的 `make release` 也是這樣做，`mk/libdav1d.mk` 的 `dav1d-release`），並在 `BUILD.md` 記下版本、sha256 與 meson 選項。
  - dav1d 不改變 FFmpeg 的 LGPL 狀態：configure 裡 `libdav1d` 屬於一般的 `EXTERNAL_LIBRARY_LIST`，不在 GPL／nonfree／version3 清單；`kikoeru-afv` 的 `config.h` 仍是 `CONFIG_GPL 0`、`CONFIG_NONFREE 0`、`LGPL version 2.1 or later` [實測]。
- 原始碼樹裡 `THANKS.md` 等不需要隨 binary 附上。
