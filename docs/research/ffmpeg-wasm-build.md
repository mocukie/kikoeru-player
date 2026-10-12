# FFmpeg wasm build pipeline 與 LGPL 合規

> Research ticket：[#10](https://github.com/mocukie/kikoeru-player/issues/10)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)）
> 調查日期：2026-10-12。對象：libav.js `v6.10.9.0`（FFmpeg 9.0）、`emscripten/emsdk:6.0.5`。
> 標記：**[實測]** 本機實際 build／執行過；**[已查證]** 對照一手來源；**[推論]** 由來源推得、未實測；**[未驗證]** 留給後續 ticket。
> 本文的授權分析不是法律意見。

## 結論先講

1. **build 可行而且很快 [實測]。** 用 libav.js 的 `mkconfig.js` 加一個 2 檔的 wrapper patch，在釘死 digest 的 `emscripten/emsdk:6.0.5` 容器內 build。從乾淨狀態開始，2 核心的 `make` 約 106 秒，整支 script 約 138 秒；4 核心約 85 秒；32 核心約 68 秒。
   - 只 build 需要的 target（`*.wasm.mjs` 與 frontend `*.mjs`）。不要用 `make build-<variant>`，它會連 asm.js、threads、debug 共 20 個檔案一起 build。
2. **產物可以 bit-for-bit 重現 [實測]。** 三次乾淨 build（不同目錄、`-j32`／`-j4`／`-j2`）得到的 `.wasm` 與 `.wasm.mjs` sha256 完全相同。所以檔名裡的 content hash 可以直接當成 build identity，CI cache 只是加速用。
3. **體積 [實測]。** 建議的 variant `kikoeru-af`（Engine 需要的全部 demuxer、decoder、parser，加上 libavfilter 與 `atempo`）：
   - wasm：raw 1948 KiB，gzip 804 KiB，**brotli 631 KiB**。
   - glue（`.wasm.mjs`）：brotli 48 KiB。frontend（`.mjs`）：brotli 6 KiB。
   - 三個檔案合計傳輸量約 **685 KiB（brotli）**。kikoeru 先前評估的 movi-player wasm 是 gzip 約 2.2 MB。
4. **libavfilter 加 `atempo` 只增加約 108 KiB raw，brotli 增加 30 KiB [實測]。** 體積不構成反對 #7 結論的理由。
   - decode、`atempo`、轉成 fltp，再加上播放中用 `avfilter_graph_send_command` 改速，都已在 wasm 內跑通。
5. **FFmpeg 9.0 的原生 opus decoder 依賴 swresample [實測、已查證]。** configure 裡寫的是 `opus_decoder_deps="swresample"`，沒開 swresample 時它會被**靜默停用**。所以 swresample 是必要元件。它同時讓 filter graph 能自動插入 `aresample`，處理 s16／s32／dbl 轉 fltp。
6. **Asyncify 的代價 [實測]。** 同一個 variant 拿掉 Asyncify 後，wasm 是 1299 KiB raw、506 KiB brotli。也就是說 Asyncify 讓 raw 多 42%，brotli 多 19%（+95 KiB）。這是 #4 留下來待量的數字。
7. **LGPL：configure 結果確認是 LGPL [實測]。** `CONFIG_GPL 0`、`CONFIG_NONFREE 0`、`CONFIG_VERSION3 0`，`FFMPEG_LICENSE "LGPL version 2.1 or later"`。
   - FFmpeg 是靜態連結進 wasm 的，所以走 LGPL-2.1 §6(a)：發布完整的對應原始碼，以及能重新連結的材料。
   - 實際做法：Release tarball 內附 `sources/`（FFmpeg tarball、libav.js tag 原始碼、patch、variant config、build script、image digest），並保留產物開頭的 license header。
   - 合規清單見第 6 節。

## 1. 建議的 pipeline

### 1.1 版本釘選 [實測：本 spike 的做法]

| 項目 | 釘法 | 本次的值 |
|---|---|---|
| emsdk | Docker image tag 加 **digest** | `emscripten/emsdk:6.0.5@sha256:76a44fff907397784decc435115d07fcb9587a4f1504977f39f3745e538e3a1e` |
| libav.js | git tag 加 **commit sha 核對** | `v6.10.9.0` = `c80e885c3461f7bb7ea565c9631b34243ae0dbf1` |
| FFmpeg | 版本由 libav.js 的 `Makefile` 決定（`FFMPEG_VERSION=9.0`），tarball 核對 **sha256**，可加 GPG | `ffmpeg-9.0.tar.xz` sha256 `7f607a00…9062d52`；`.asc` 以 FFmpeg release signing key `FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8` 驗證通過 |
| emfiberthreads | sha256（base target 一律連結；0BSD） | `v1.3` `0fe933d7…fcbcb` |
| zlib／libopus（選用） | sha256 | zlib 1.3.2 `bb329a0a…19d16`；opus 1.6.1 `6ffcb593…a411a1` |
| terser 等 node 工具 | libav.js 自帶的 `package-lock.json`，用 `npm ci` 安裝 | — |

- **emsdk 版本的選法。** libav.js `v6.10.9.0` 上游 CI 用的是 `setup-emsdk` 的 `version: 6.0.5`（`.github/workflows/build-and-test.yaml`）[已查證]。我們跟上游一致，比較不會踩到 emscripten 新版的行為改變。升級 libav.js 時，一併參考它 CI 的 emsdk 版本。
- **上游 Makefile 下載依賴時不驗證 [已查證：`mk/ffmpeg.mk`、`mk/zlib.mk`、`mk/opus.mk`、`mk/emfiberthreads.mk` 都是直接 `curl`]。** 所以 build script 要先把 tarball 放進 `build/` 並核對 sha256。`make` 看到檔案已存在，就不會再下載。
- 官方的 `Dockerfile.development` 自己標明「NOT MAINTAINED BY THE AUTHOR」，而且用沒有 tag 的 `emscripten/emsdk` [已查證]，不採用。我們的 Dockerfile 只多裝 `pkg-config` 與 `m4`：
  - `m4`：如果 `Makefile.m4` 比 `Makefile` 新，`make` 會重新產生 `Makefile`，需要它。
  - `pkg-config`：FFmpeg 找外部 lib 時要用。
- libav.js 的版本號是「libav.js 主版本.次版本.FFmpeg 主版本.FFmpeg 次版本」，產物檔名本身就帶版本，例如 `libav-6.10.9.0-kikoeru-af.wasm.wasm` [已查證]。

### 1.2 build 指令（不用 fork）

```sh
git clone --depth 1 --branch v6.10.9.0 https://github.com/Yahweasel/libav.js && cd libav.js
patch -p1 < libavjs-accessors.patch                         # 見第 4 節
cd configs && ./mkconfig.js kikoeru-af '[...fragments...]' && cd ..
make -j"$(nproc)" dist/libav-6.10.9.0-kikoeru-af.wasm.mjs dist/libav-6.10.9.0-kikoeru-af.mjs dist/libav.types.d.ts
```

- 完整的 script 放在 branch 的 `research/build-spike/`，是拋棄式的（見第 7 節）。
- 正式版建議搬到 repo 內固定的位置（例如 `wasm/`），內容包括：Dockerfile、`variants`（fragment 清單）、patch、`versions`（上表的釘選值），以及 build script。

### 1.3 GitHub Actions 與 cache

**build 時間 [實測，本機 32 執行緒，以 `--cpus` 與 `-j` 模擬]**

| 核心數 | `make`（FFmpeg configure、compile、link 與 wasm-opt） | 整支 script（clone、下載、`npm ci`、build、量測；image 已存在） |
|---|---|---|
| 32 | 67–68 s | — |
| 4（public repo 的 `ubuntu-latest`） | 85 s | — |
| 2（**private repo 的 `ubuntu-latest`**） | 106 s | 138 s |

- 核心數多寡影響不大，因為 link 階段（Asyncify 加 `-Oz` 的 wasm-opt）是單執行緒。
- GitHub 文件的規格是：public repo 的 `ubuntu-latest` 為 4 vCPU／16 GB，private repo 為 2 vCPU／8 GB [已查證：GitHub-hosted runners reference]。本 repo 目前是 private。
- 第一次在 CI 拉 emsdk image（壓縮約 0.85 GB）要另外加幾十秒 [推論]。
- 估計：**CI 上一次乾淨 build 單一 variant 大約 3 分鐘**。

**cache 策略**
- build 只要 2–3 分鐘，而且產物可以重現，所以 **cache 不是必要的**。持久保存要靠 Release，而不是 Actions cache。Actions cache 有這些限制 [已查證：GitHub「Dependency caching reference」]：
  - 7 天沒被存取就會被刪。
  - 每個 repo 預設上限 10 GB，超過時從最久沒用的開始清。
  - 同一個 key 的內容不能改寫。
  - 只能讀到目前 branch、default branch，以及 PR base branch 建立的 cache。
- 建議的做法：**以輸入的 hash 決定要不要 build。**
  1. `key = hash(wasm/**)`，涵蓋 Dockerfile、fragments、patch、版本與 sha256 清單。
  2. 先查 tag 為 `ffmpeg-wasm-<libav.js 版本>-<key 前 8 碼>` 的 Release 是否已存在；存在就跳過 build。
  3. 想省下載時間的話，可以用 `actions/cache` 存 `build/*.tar*` 等上游 tarball（key = 版本清單的 hash）。這是上游 CI 的做法（`key: cache-dependencies-${{ hashFiles('mk/*') }}`）[已查證]。
  4. emsdk image 不必特地 cache。
- 只在 `wasm/**` 有變動時（或手動 `workflow_dispatch`）觸發 build；Engine 的一般 CI 直接下載已發佈的 Release。

### 1.4 產物形式：命名、MIME、lazy load

- **Release tarball 的內容**（比照 ADR-0010 的 Release tarball 方向）：
  - `dist/`：`libav-<ver>-<variant>.wasm.wasm`、`.wasm.mjs`、`.mjs`、`libav.types.d.ts`。
  - `SHA256SUMS`。
  - `sources/` 與 `NOTICE`，見第 6 節。
- 下游（Engine 的 build）以「固定 tag 加 sha256」下載。
- **檔名帶 hash。**
  - 上游產物的檔名只有版本號，沒有 content hash。
  - 建議由 Engine 的程式碼用 `new URL("./libav-kikoeru.wasm", import.meta.url)` 參照，交給 App 的 Vite 產生帶 hash 的 asset，再用 libav.js 的 `wasmurl` 選項把這個 URL 傳進去；factory 則以 `factory` 選項傳入自己 import 的模組 [已查證：README「Bundlers」]。
  - 不傳 `wasmurl` 時，glue 會用 `new URL("libav-6.10.9.0-<variant>.wasm.wasm", import.meta.url)` 找檔案 [實測：檢視產物]。
  - kikoeru 的 research 指出，Vite 的 dependency pre-bundling 可能讓 `new URL(…, import.meta.url)` 找不到 wasm，需要 `optimizeDeps.exclude` [未驗證：留給 Engine 打包的 ticket]。
- **streaming compile。**
  - glue 以 `WebAssembly.instantiateStreaming(fetch(url, {credentials: "same-origin"}))` 編譯；失敗時印出 `wasm streaming compile failed`，退回 ArrayBuffer 編譯 [實測：檢視產物]。
  - 規格要求 Response 必須 CORS-same-origin、狀態為 ok，而且 MIME 是 **`application/wasm`**，否則 reject 並拋出 TypeError [已查證：WebAssembly Web API spec「compile a potential WebAssembly response」]。
  - 所以 wasm 要以 `Content-Type: application/wasm` 同源送出。gzip 或 brotli 的 `Content-Encoding` 不影響 streaming。
  - kikoeru 後端（Quarkus／Vert.x）：Vert.x 4.x 的 `MimeMapping` 有 `wasm → application/wasm` [已查證：vert.x `4.x` 分支 `MimeMapping.java`]。實際部署的 header 仍需用 `curl -I` 確認 [未驗證]。
- **lazy load。** Engine 在第一次 `load()` 時才在 Worker 內 import factory 並 instantiate。glue 加 frontend 約 54 KiB（brotli），沒有放進主 bundle 的理由。
- **compile 一次、instantiate 多次 [推論，未驗證]。** 每個來源各用一個 instance（#3 的結論），不必每次重新 fetch 與 compile：
  - Emscripten 的 glue 支援 `Module.instantiateWasm(imports, cb)` hook [實測：檢視產物]。
  - libav.js 在 noworker 模式只把 `{wasmurl, variant}` 傳給 factory，所以要包一層 `factory`：先 `compileStreaming` 一次，之後用 `WebAssembly.instantiate(module, imports)` 建立 instance。
  - 要在實作 ticket 中驗證，Asyncify 的 `instrumentWasmExports` 是否仍正常運作。

## 2. variant 內容

fragment 清單見 `research/build-spike/variants.sh`。configure 後確認實際編進去的元件如下 [實測：產生的 `codec_list.c`、`parser_list.c`、`demuxer_list.c`、`filter_list.c`]：

| 類別 | 實際啟用的元件 |
|---|---|
| demuxer | aac、caf、flac、matroska、mov、mp3、ogg、wav、wv |
| decoder | aac、alac、flac、mp3float、opus（原生）、vorbis、wavpack、pcm_{s16le,s16be,s24le,s24be,s32le,s32be,f32le,f32be,f64le,f64be,u8,s8} |
| parser | aac、av1、flac、h264、hevc、mpegaudio、opus、vorbis、vp9 |
| bsf | **不開** |
| filter（`-af` 版） | abuffer、abuffersink（FFmpeg 固定編入）、aformat、aresample（swresample fragment 帶入）、atempo |
| protocol | data、file（libav.js 的 avformat fragment 固定開啟；block reader device 走 file） |
| 字幕 | **不開任何 decoder**：ASS／SSA／SRT（matroska）與 mov_text（mp4）只要 demuxer，封包原文直接傳出 |

- **不需要 bsf [實測]。**
  - mov 與 matroska 的 H.264／HEVC extradata 本來就是 avcC／hvcC（smoke test 中 H.264 為 44 B、HEVC 為 2413 B，可直接當 WebCodecs 的 `description`）。
  - Engine 不支援 MPEG-TS 或裸 Annex B，所以 `extract_extradata` 用不到。
- **mp3 只開 `mp3float`**，輸出 fltp。
- **zlib 沒有放進預設 variant。**
  - Matroska 的 ContentCompression（zlib）與 mov 的 `cmov` 需要 zlib。
  - 代價是 +23 KiB raw、+11 KiB brotli [實測]。
  - 舊版 mkvmerge 產生的字幕軌有時會用 zlib 壓縮 [推論]。如果測試媒體遇到這種檔案，再加上 `"zlib"` fragment（zlib License，在 header 加一份 notice）。
- **原生 opus 與 libopus 的比較 [實測]。**
  - 用 libopus（BSD-3-Clause，不需要 swresample）的 variant，wasm 是 1841 KiB raw、611 KiB brotli，比原生 opus 加 swresample 的 601 KiB 還大。
  - 而且 `-af` 版本來就需要 swresample 做格式轉換，所以選原生 opus。
- **AIFF 沒有列入。** 需要的話只要加 `demuxer-aiff`；它的 PCM 為 big-endian，相關 decoder 都已經開了。

## 3. 量測結果 [實測]

量法：raw；`gzip -9`；brotli quality 11（Node `zlib`）。單位 KiB。script 是 `research/build-spike/measure.mjs`。

| variant | 內容 | wasm raw | wasm gzip | wasm brotli | glue `.wasm.mjs` brotli | frontend `.mjs` brotli |
|---|---|---|---|---|---|---|
| （第一輪，無 opus） | 少了 opus 與 swresample | 1721.2 | 710.9 | 558.1 | 45.6 | 5.7 |
| `kikoeru` | 全部 demuxer、decoder、parser，加上 swresample | 1839.7 | 764.5 | 600.6 | 45.7 | 5.7 |
| **`kikoeru-af`（建議）** | `kikoeru` 加 avfilter、atempo、aformat | **1947.5** | **804.0** | **630.6** | 47.8 | 5.8 |
| `kikoeru-libopus` | opus 改用 libopus，拿掉 swresample | 1841.4 | 775.3 | 611.0 | 46.2 | 5.7 |
| `kikoeru-zlib` | `kikoeru` 加 zlib | 1862.9 | 777.1 | 611.7 | 46.0 | 5.7 |
| `kikoeru` 不開 Asyncify（只用來比較，不能用） | — | 1298.7 | 615.2 | 505.9 | 43.9 | — |

- glue 的 raw 大小約 265–279 KiB，其中約 30 KiB 是 license header；header 的壓縮率很高。
- frontend 的 raw 大小約 27 KiB。
- 增量：
  - opus 加 swresample：+118 KiB raw、+43 KiB brotli。
  - libavfilter、atempo、aformat：+108 KiB raw、+30 KiB brotli。
  - zlib：+23 KiB raw、+11 KiB brotli。
  - Asyncify：+541 KiB raw、+95 KiB brotli。
- 跟 #3 用 `fragment-sizes.csv` 加總估出的 1.8–2.1 MiB 相符。

**smoke test [實測]**（`research/build-spike/smoke.mjs`，在 Node 以 `noworker` 載入，fixture 由 ffmpeg 7.1 產生）：

- mkv：H.264、opus（default）、aac、ASS（forced）、SRT，容器時間偏移 1 秒。mp4：HEVC、ALAC 96 kHz、mov_text。另外還有 wv、mp3、flac、ogg（vorbis）、wav（s24、192 kHz；f64）、aac（ADTS）、caf（ALAC）。**全部都能 demux 與 decode。**
- patch 加的 accessor 正常運作：
  - opus 軌 `disposition=1`（default），ASS 軌 `disposition=64`（`AV_DISPOSITION_FORCED`）。
  - mkv 各軌 `start_time=1000`（tb 1/1000）。
- 字幕：
  - ASS 的 extradata 是 482 B 的 header 原文，封包內容是 `ReadOrder,Layer,Style,…` 原文。
  - SRT 封包是純文字。
  - mov_text 封包是 tx3g 原文：開頭 2 bytes 是 big-endian 長度，接著是文字。Engine 或 App 要自己剝掉長度欄位。
- `-af` 版的 `ff_decode_filter_multi` 管線：decode、`atempo=1.5`、中途用 `avfilter_graph_send_command(graph,"atempo","tempo","0.75",…)` 改速（回傳 0）、輸出 fltp。所有格式（fltp、s16、s16p、s32、s32p、dbl）的樣本數都符合預期。

**實作時要注意的地方 [實測]**

- **libav.js 的 `ff_copyout_frame` 不支援 `AV_SAMPLE_FMT_DBL`／`DBLP`。** pcm_f64 解出來的 frame，`data` 是 `null`（`src/p-avframe.in.js` 只處理 u8、s16、s32、flt 與它們的 planar 版本）。
  - 建議：音訊**一律經過 filter graph 輸出 fltp**，也就是 `ff_decode_filter_multi`。1.0x 時改用只有 `aformat=sample_fmts=fltp` 的 graph。
  - 這樣也順便在 wasm 內完成整數轉 float 與 planar 統一，JS 端只需要處理 fltp。
  - 另一個做法是再 patch，加上 f64 copier，不建議。
- **沒有 channel mask 的 WAV**（例如 IEEE float 格式），channel layout 是 unspecified（mask 為 0），`abuffer` 會回 `Invalid argument`。Engine 要依聲道數補上預設 layout。
- 解碼時會出現「Could not update timestamps for skipped samples」警告，原因是 decoder 沒有設定 `pkt_timebase`。`ff_init_decoder` 應該帶入 stream 的 `time_base` [推論]。

## 4. wrapper patch（`research/build-spike/libavjs-accessors.patch`）

這個 patch 只改 libav.js 自己的 wrapper（0BSD），不動 FFmpeg：

- `src/b-avformat.c`：在 AVStream 加上 `B(int, disposition)` 與 `BL(int64_t, start_time)`。
- `funcs.json`：
  - AVStream accessors 加上 `disposition`、`start_time`、`start_timehi`。
  - avfilter functions 加上 `avfilter_graph_send_command`。原本**沒有 export**，沒有它就無法在播放中改 `atempo` 的速度，只能重建 graph。

這個 patch 適合 upstream PR。upstream 接受後，下一次升級 libav.js 時就可以拿掉。

## 5. 授權背景 [已查證]

- **FFmpeg** 是 LGPL-2.1-or-later；只要用到 GPL 的選用部分，整個 FFmpeg 就適用 GPL（ffmpeg.org/legal.html）。
  - 我們的 configure 沒有 `--enable-gpl`、`--enable-nonfree`、`--enable-version3`，`config.h` 也確認是 LGPL 2.1 or later [實測]。
  - libav.js 的 `configs/` 與 `mk/` 裡沒有任何 fragment 會打開這些選項（#3）。
- **libav.js** 的 wrapper、frontend、build 工具是 0BSD。它的 LICENSE.md 寫明：「libav.js builds include correct license headers. Do not remove them」，並要求只要有超出設定以外、會連結進 FFmpeg 的修改，就必須公開。
- **emfiberthreads** 是 0BSD，不需要標示。
- **emscripten／musl** 是 MIT，已經包含在 header 裡。
- **FFmpeg 的 oggdec** 部分是 MIT 型授權，也已經在 header 裡。
- 產物的 license header：
  - `*.wasm.mjs` 開頭有一段約 30 KB 的 `/*! … */`，內容是 FFmpeg 的 LGPL 2.1 全文、oggdec 授權與 emscripten／musl 授權 [實測]。
  - frontend 的 `.mjs` 沒有 header（它是 0BSD）。
  - `.wasm` 是二進位檔，本身不帶 notice。
- **靜態連結。**
  - wasm 把 FFmpeg 靜態連結在一起，FFmpeg checklist 的「Use dynamic linking」做不到。所以要走 LGPL-2.1 §6(a)：附上 Library 完整且對應的原始碼（含修改），加上「work that uses the Library」的 object code 或 source，「so that the user can modify the Library and then relink」。
  - wasm 裡的其他部分（libav.js wrapper、emfiberthreads、emscripten runtime）都是公開原始碼。只要發佈原始碼、patch 與可重現的 build script，任何人都能改 FFmpeg 後重 build 出等價的 wasm [推論]。
  - §6(d) 允許「從指定地點提供複製」，條件是在同一個地點提供原始碼。
- **Engine 的 TS 程式碼 [推論]。** 它是另一個 JS 檔，在執行期透過 export 呼叫 wasm，而且可以用 `wasmurl`／`factory` 換掉 wasm，性質接近 §6(b) 的「suitable shared library mechanism」。
  - 不過 §6 也要求整體作品的條款「permit modification of the work for the customer's own use and reverse engineering for debugging such modifications」。
  - kikoeru 與 kikoeru-player 目前都是 private repo，也沒有 LICENSE。**發佈給第三方之前，授權條款不能禁止修改與逆向工程。**這件事需要 repo owner 決定。

## 6. LGPL 合規清單（Engine 的 Release 與 kikoeru 的部署）

以 ffmpeg.org/legal.html 的「License Compliance Checklist」與 LGPL-2.1 §6 為準，對應到我們的做法：

**build 階段**
- [ ] configure 不得出現 `--enable-gpl`、`--enable-nonfree`、`--enable-version3`。CI 在 build 後檢查 `config.h`：`CONFIG_GPL 0`、`CONFIG_NONFREE 0`，`FFMPEG_LICENSE` 為 `LGPL version 2.1 or later`，不符合就讓 build 失敗。
- [ ] 不得連結任何 GPL 的外部 lib（例如 libx264、librubberband）。新增 fragment 時，對照 FFmpeg `configure` 的 `EXTERNAL_LIBRARY_GPL_LIST`。
- [ ] 每加入一個外部 lib（zlib、libopus 等），就把它的授權與原始碼也納入下列各項（checklist：「Go through all the items again for any LGPL external library」）。

**Release tarball（隨產物一起）**
- [ ] `sources/ffmpeg-9.0.tar.xz`：原封不動的上游 tarball，與 binary 完全對應。
- [ ] `sources/libav.js-v6.10.9.0.tar.xz` 加上 `sources/libavjs-accessors.patch`；也就是 libav.js 對 FFmpeg 打的 patch（`patches/ffmpeg/*`、`series9`，已包含在 libav.js 原始碼內）加上我們的 wrapper patch。
  - FFmpeg checklist 要的是「git diff > changes.diff」與「configure line」的對等物。libav.js 的 FFmpeg patch 本身在它的原始碼裡。
- [ ] `sources/emfiberthreads-1.3.tar.gz`，以及有用到的話 `zlib-*.tar.gz`、`opus-*.tar.gz`。
- [ ] `sources/BUILD.md`：寫明 emsdk image digest、libav.js tag 與 commit、variant 的 fragment 清單、**完整的 FFmpeg configure line**（從 `config.h` 的 `FFMPEG_CONFIGURATION` 取得）、build 指令，以及 `SHA256SUMS`。build script 本身也一起放進去。
- [ ] `NOTICE`：寫明「This software uses code of FFmpeg licensed under the LGPLv2.1 and its source can be downloaded <link>」，並附上 LGPL-2.1 全文（§6：「You must supply a copy of this License」）。
- [ ] **不要剝掉 `*.wasm.mjs` 的 `/*! … */` license header。** Engine 打包時要確認 bundler 會保留 legal comment，或不 minify 這個檔案 [未驗證：交給 Engine 打包的 ticket]。
- [ ] 檔名不要改成看不出來源的名稱。checklist 允許加前後綴，不允許改名；`libav-<ver>-kikoeru-af.*` 或加上 hash 後綴都符合。

**部署與發佈（kikoeru 端）**
- [ ] 原始碼要放在跟 wasm 同一個地方提供（§6(d)；checklist：「Host the FFmpeg source code on the same webserver as the binary」）。kikoeru 的 Release 或 Docker image 應該帶著 `sources/`，或提供一個公開、長期有效的連結。**private repo 的 Release 對收到 binary 的第三方來說不算可取得。**
- [ ] App 的 about／授權頁加上「This software uses libraries from the FFmpeg project under the LGPLv2.1」，並連到 NOTICE 與原始碼。
- [ ] 授權條款或 EULA 不得禁止逆向工程與自行修改（§6）。目前沒有 LICENSE，需要 repo owner 決定。
- [ ] 如果只是自己使用、不散布給第三方，LGPL 的散布義務不會觸發。但只要讓別人透過瀏覽器下載 wasm，就算散布 [推論]。

**不需要做的**
- 不必提供「relink 用的 object code」以外的私有程式碼：wasm 的其他組成都是公開原始碼。Engine 的 JS 是獨立的檔案，可以替換 wasm（見第 5 節的推論）。

## 7. 拋棄式 spike 的位置與重現方式

branch `research/ffmpeg-wasm-build` 的 `research/build-spike/`（不含任何產物）：

| 檔案 | 內容 |
|---|---|
| `Dockerfile` | `emscripten/emsdk:6.0.5@sha256:76a4…` 加 `pkg-config`、`m4` |
| `variants.sh` | 4 個 variant 的 fragment 清單（`kikoeru`、`kikoeru-af`、`kikoeru-libopus`、`kikoeru-zlib`） |
| `libavjs-accessors.patch` | 第 4 節的 wrapper patch |
| `build.sh` | clone 並核對 commit、打 patch、下載並核對 sha256、在 Docker 內 `mkconfig` 加 `make`、量測。`JOBS=2` 可以模擬 CI 的核心數 |
| `measure.mjs` | 量測 raw、gzip、brotli |
| `smoke.mjs` | Node `noworker` 的 demux、decode、atempo smoke test |

```sh
research/build-spike/build.sh /tmp/wasm-work kikoeru-af        # 產物：/tmp/wasm-work/libav.js/dist/
node research/build-spike/smoke.mjs /tmp/wasm-work/libav.js/dist kikoeru-af <媒體檔...>
```

「libav.js 讀取中止與並行行為的實測」ticket（#17）可以直接用 `kikoeru-af` 這個 variant。正式的 pipeline 要另外寫到 `wasm/` 與 workflow 裡，不要直接沿用 spike。

## 8. 留給後續的事項

- Engine 打包：bundler 是否保留 license header、Vite 的 `new URL(…, import.meta.url)` 與 pre-bundling、`factory` 加 `instantiateWasm` 能否做到 compile 一次、instantiate 多次。
- kikoeru 部署：確認 `.wasm` 的實際 `Content-Type` 與壓縮（brotli／gzip），以及 `sources/` 的提供位置。
- 是否加入 zlib：看測試媒體裡有沒有 zlib 壓縮的 MKV 字幕軌。
- 把 wrapper patch 送 upstream PR。

## 來源

- libav.js `v6.10.9.0`（commit `c80e885`）：`Makefile.m4`、`mk/ffmpeg.mk.m4`、`mk/{zlib,opus,emfiberthreads}.mk`、`configs/mkconfig.js`、`configs/fragments/*`、`docs/CONFIG.md`、`docs/API.md`、`README.md`（Bundlers）、`LICENSE.md`、`Dockerfile.development`、`.github/workflows/build-and-test.yaml`、`src/b-avformat.c`、`src/p-avframe.in.js`、`funcs.json` — https://github.com/Yahweasel/libav.js/tree/v6.10.9.0
- FFmpeg 9.0 `configure`（`opus_decoder_deps="swresample"`、`aresample_filter_deps="swresample"`）與 build 產生的 `config.h`、`*_list.c`；release tarball 與簽章 — https://ffmpeg.org/releases/ 、https://ffmpeg.org/ffmpeg-devel.asc
- FFmpeg License and Legal Considerations（License Compliance Checklist）— https://ffmpeg.org/legal.html
- GNU LGPL v2.1 §6 — https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt
- Docker Hub `emscripten/emsdk` tags 與 digest — https://hub.docker.com/r/emscripten/emsdk
- GitHub Docs：Dependency caching reference（eviction、10 GB、key 不可改寫、branch 存取限制）— https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching ；GitHub-hosted runners reference（public 與 private 的 `ubuntu-latest` 規格）— https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- WebAssembly Web API（`application/wasm`、CORS-same-origin）— https://webassembly.github.io/spec/web-api/
- Vert.x `MimeMapping.java`（4.x）— https://github.com/eclipse-vertx/vert.x/blob/4.x/src/main/java/io/vertx/core/http/impl/MimeMapping.java
- 本 repo 前置研究：`research/libavjs-evaluation`（#3）、`research/wasm-async-bridge`（#4）、`research/time-stretch`（#7）、`research/webcodecs-support`（#5）
