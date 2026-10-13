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

  主 variant 內的 dav1d（mix、Asyncify）是最佳組合的 95–97%。也就是說，**選項 A 與選項 B 的速度差只有 3–5%**，選擇要看體積、載入時機與執行緒配置（§5、§9）。
