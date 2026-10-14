# 桌面 Firefox、Safari 的媒體測試自動化

> 為決策 ticket [測試策略](https://github.com/mocukie/kikoeru-player/issues/22)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)）準備資料。
> 實測日期：2026-10-14。對象：`mcr.microsoft.com/playwright:v1.64.1-noble`（Firefox 157.0、Chromium 156、WebKit 27.2）、正式版 Firefox 158.0 + geckodriver 0.37.1（`node:24`／bookworm）、Vitest 5.0.4 browser mode。
> 標記：**[實測]** 本次在本機 Docker 內量到；**[文件]** 對照官方文件、原始碼或 issue tracker；**[未測]** 本次無法確認。
> 探測程式在 branch 的 `research/browser-automation-spike/`。

## 結論先講

1. **桌面 Firefox 可以在 Linux Docker 內自動化**，Playwright 的 Firefox 157 與正式版 158 在所有媒體項目上行為一致 [實測]。條件有三：系統要有 libavcodec（否則 H.264 與 AAC 不能用）、container 內要有 PulseAudio 的 null sink（否則 `resume()` 永遠不會完成）、要設 autoplay pref 或先點一下（§1）。
2. **Firefox 解出的 `VideoFrame` 格式是 `BGRX`**，Chromium 與 WebKit 是 `I420` [實測]。影片繪製路徑兩種都要處理。
3. **Safari 不能在 Docker 內跑**，只能用 GitHub Actions 的 macOS runner：headed、同時只有一個 WebDriver session、音訊裝置偶爾會缺，AV1 預期不支援；repo 為 private 時每分鐘 $0.062（§2）。
4. **Linux 的 Playwright WebKit 不能代表 Safari 的媒體行為**：媒體走 GStreamer，AV1 的 `isConfigSupported` 回 true 但解碼全部失敗 [實測]（§3）。
5. **iOS Simulator 不適合驗證鎖屏與背景播放**，仍需實機（§4）。

## 1. 桌面 Firefox（Linux Docker）

### 媒體能力 [實測]

| 項目 | 結果 |
|---|---|
| Worker 內的 wasm | 可用；加上 COOP/COEP 時 shared memory、SIMD、`crossOriginIsolated` 皆為 true。 |
| VideoDecoder：VP9、AV1 | 三種 `hardwareAcceleration` 模式的 `isConfigSupported` 皆為 true，30／30 frame 解出。用 Firefox 內建的 decoder（libmozavcodec／ffvpx），不依賴系統 FFmpeg；Opus、FLAC、MP3 也一樣。 |
| VideoDecoder：H.264（`avc1.64001f`） | Annex B 與 avcC 皆 30／30 frame 解出，**但前提是系統有 FFmpeg 的 library**。 |
| 解出的 frame 格式 | 兩個 Firefox 都是 `BGRX`；Chromium、WebKit 是 `I420`。 |

**H.264 與 AAC 依賴系統的 libavcodec** [實測]：

- Playwright image 有 Ubuntu 的 `libavcodec60`（6.1.1）與 `libopenh264-7`；`node:24`／bookworm 有 `libavcodec59`。
- 刪掉 libavcodec 後兩個 Firefox 都失去 H.264 與 AAC：`isConfigSupported` 回 false、解碼丟 `NotSupportedError`、`canPlayType` 回 `""`；VP9 與 AV1 不受影響。
- 系統的 `libopenh264` 不能替代 libavcodec。Playwright 的 `playwright.cfg` 關掉了 GMP 下載（`media.gmp-manager.updateEnabled=false`），所以 Firefox 的 OpenH264 plugin 也不會被取得。
- 自己做 image 時要裝完整的 `libavcodecNN`。

### AudioContext 與 AudioWorklet [實測]

1. **需要 sound server**。container 內沒有 PulseAudio 時，Firefox 的 `resume()` 永遠不會 settle、context 停在 `suspended`，即使允許 autoplay 並真的點擊過也一樣；`media.cubeb.force_null_context`、`force_mock_context` 都無效。以一般使用者執行 `pulseaudio -D` 再 `pactl load-module module-null-sink` 後，`currentTime` 依實際時間前進，1.5 秒內 `process()` 被呼叫 500 次。OfflineAudioContext 加 worklet 有沒有 sound server 都能用。
2. **需要 autoplay 授權**。在 Vitest 的測試 iframe 內，沒有 gesture 建立的 context 會停在 suspended（`getAutoplayPolicy` 回 `"disallowed"`）。解法擇一：先呼叫 `vitest/browser` 的 `userEvent.click()`，或設 pref `media.autoplay.default: 0`（Playwright 用 `firefoxUserPrefs`，webdriverio 用 `moz:firefoxOptions.prefs`）。
3. **Chromium 不要接 PulseAudio**：沒有 PulseAudio 時正常；接上 null sink 後時鐘停住或變慢（`dt` 0.012–1.2 s）。Chromium 在 Vitest 內需要 `--autoplay-policy=no-user-gesture-required` 或先點擊。

**測試框架會偷偷給 gesture** [實測 + 原始碼]：Playwright 的 `page.evaluate` 在 CDP 帶 `userGesture: true`、在 BiDi 帶 `userActivation: true`（playwright-core 1.64.1 原始碼）。經由 `evaluate` 建立的 context 因此可以直接出聲，但頁面自己的程式或 Vitest 測試不行。Vitest 走 Playwright 的 `moz-firefox`（BiDi）channel 時，Firefox 在點擊前就回報 `allowed`。不要依賴這個行為，一律明確設定 autoplay 或明確點擊。

### Playwright 的 Firefox 與正式版的差異

- [實測] 媒體上沒有差異：codec、對系統 FFmpeg 的依賴、對 PulseAudio 的依賴、frame 格式都相同。
- [文件] Playwright 的 Firefox 是打過 patch 的 build（Juggler），文件說它對齊近期的 Stable，正式版的 branded build 不能直接用（https://playwright.dev/docs/browsers）。`playwright.cfg` 只改了少數媒體 pref（GMP 更新、screencapturekit）。版本略落後（157 對 158）。
- [實測 + 原始碼] Playwright 1.64.1 有一個未寫在文件的 `channel: 'moz-firefox'`，配合 `executablePath` 可經 WebDriver BiDi 驅動正式版 Firefox，整組 Vitest 探測都能對 Firefox 158 跑完。

### Vitest webdriverio provider 的坑 [實測]

`@vitest/browser-webdriverio@5.0.0` 搭配 `webdriverio@10.0.2` 時 `userEvent` 會壞（"`switchFrame` was removed for WebDriver BiDi sessions in WebdriverIO v10"）；釘 `webdriverio@9`（9.32.0）可用。它的 peer dependency 寫 `webdriverio: "*"`，不會有任何警告。

## 2. 桌面 Safari

- **不能用 Docker** [文件]：Safari 只在 macOS 上，也沒有 headless 模式。Vitest 的 webdriverio provider 會丟 "You've enabled headless mode for Safari but it doesn't currently support it"（`@vitest/browser-webdriverio` 原始碼）；設了 `CI` 時 Vitest 會自動開 headless，所以 Safari 的 instance 要明確設 `headless: false`。Playwright 不能驅動 branded Safari（https://playwright.dev/docs/browsers）。
- **同時只能一個 session** [文件]：Safari 只允許一個瀏覽器 instance 與一個 WebDriver session，在隔離的自動化視窗內執行，所以 Vitest 跑 Safari 必須 serial（https://developer.apple.com/documentation/webkit/about-webdriver-for-safari）。
- **runner 已預先設定** [文件]：image 建置時已執行 `sudo safaridriver --enable` 並設定 `AllowRemoteAutomation`（https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/install-safari.sh）。
- **runner 上的 Safari 版本** [文件，runner-images README，2026-09～10]：

  | Runner label | macOS | Safari／SafariDriver |
  |---|---|---|
  | `macos-latest` = `macos-26`（arm64） | 26.6.2 | 26.6.2 |
  | `macos-26-intel` | 26.6.1 | 26.6 |
  | `macos-15`（arm64） | 15.7.9 | 26.6.1 |
  | `xcode-27`（preview） | 27.0.1 | 27.0.1 |

  `macos-14` 已 deprecated。標準 arm64 runner 是 M1 VM，3 vCPU、7 GB RAM，沒有 GPU 與 nested virtualization（https://docs.github.com/en/actions/reference/runners/github-hosted-runners）。
- **音訊輸出裝置** [文件]：image 依賴 macOS 內建的 "Null Audio Device"，BlackHole 已不再預裝。open issue #13668（2026-02，macos-15 larger runner）回報 Null Audio Device 有時不存在，此時 Safari 的 Web Audio 會失敗（`kAudioQueueErr_InvalidDevice (-66680)`）（https://github.com/actions/runner-images/issues/13668）。已知的 workaround：`brew install blackhole-2ch`、`sudo killall coreaudiod`、`SwitchAudioSource -s "BlackHole 2ch"`（https://github.com/actions/runner-images/issues/11746），並預先寫入 TCC 的麥克風授權避免卡住（https://github.com/actions/runner-images/issues/9330）。job 開始時用 `system_profiler SPAudioDataType` 檢查，沒有裝置就直接失敗。
- **safaridriver 下的 autoplay** [未測]：Apple 沒有文件。WebKitGTK 的自動化 view 會強制 autoplay 為允許（`WebKitWebView.cpp`：`isControlledByAutomation` → `WEBKIT_AUTOPLAY_ALLOW`），但 Safari 的 Cocoa 實作不公開。建立或 resume AudioContext 前先 `userEvent.click()`，並在 runner 上實測。
- **WebCodecs** [文件 + 未測]：Safari 26 有 VideoDecoder（16.4 起），H.264、VP9 應可用。Safari 的 WebCodecs AV1 據報只支援硬體解碼（M3+／A17 Pro 以後），runner 是 M1，預期 AV1 不支援。未在 runner 上驗證。
- **費用** [文件]：public repo 的標準 runner 免費且不限量；**`mocukie/kikoeru-player` 目前是 private**（`isPrivate: true`）。macOS 每分鐘 $0.062，Linux 2 核每分鐘 $0.006，每個 job 無條件進位到整分鐘。內含分鐘數：Free 每月 2,000，Pro 與 Team 3,000；目前文件未再寫明 macOS 對內含分鐘數的倍率（過去是 10 倍）（https://docs.github.com/en/billing/reference/actions-runner-pricing、https://docs.github.com/en/billing/concepts/product-billing/github-actions）。

## 3. Linux 的 Playwright WebKit 能否代表 Safari

**只適合檢查 API 的形狀，不能代表媒體行為** [實測 + 文件]。

- 一致的部分：WebKit 27.2（WPE／GTK build，UA 是 Mac Safari）的 AudioWorklet 可用；沒有 gesture 的 context 進入 Safari 特有的 `interrupted` 狀態，真的點擊後解鎖；沒有 PulseAudio 也能跑；VideoDecoder 存在，H.264 與 VP9 30／30 frame 解出；Worker 內的 wasm 與 threads 可用。
- 不同的部分：媒體走 image 內的 GStreamer plugin（gst-libav、openh264、vpx、aom、svtav1、va），不是 VideoToolbox 或 AVFoundation。**AV1 的 `isConfigSupported` 回 true，但每次解碼都是 `EncodingError: Decode error`**，同一批資料 Chromium 與 Firefox 都能解。codec 支援、decoder 輸出與失敗方式都跟著 Linux 的套件走，不是 Safari 的行為。
- Playwright 自己的說法：WebKit 由 WebKit main 建置，領先 Safari；codec 在 Linux、macOS、Windows 之間「差異很大」；影片播放與最接近 Safari 的行為要用 macOS（https://playwright.dev/docs/browsers）。

## 4. iOS Safari 的 CI [文件 + 判斷]

- macOS runner 內附多個 iOS Simulator runtime（`macos-26` 有 iOS 26.0–26.5，`xcode-27` 有 iOS 27.x）。Mobile Safari 可以用 safaridriver（`platformName: 'iOS'`、`safari:useSimulator: true`，iOS 13 起，https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/）或 Appium 的 XCUITest／Safari driver 驅動。Playwright 只有桌面 WebKit 的裝置模擬；Vitest 的 webdriverio provider 沒有 iOS 的正式設定，但大概能直接傳 capabilities。
- Simulator 跑的是 Mobile Safari 的 WebKit，但媒體與音訊走 macOS 主機的路徑：聲音送到 Mac 的 CoreAudio 裝置（runner 上一樣有 Null 裝置不穩的問題），也不會如實模擬 iOS 的 audio session 中斷、背景或鎖屏的暫停策略與硬體 decoder。可以拿來做 API 與功能的 smoke test、autoplay 與 gesture 的邏輯；**鎖屏與背景播放（Now Playing、鎖屏或背景時持續出聲）必須用實機**（手動或 BrowserStack、Sauce 這類裝置雲）。本次沒有跑 Simulator。

## 對測試策略的意義

- 一個 Linux 的 Playwright image 就能涵蓋 Chromium 與 Firefox 的完整媒體路徑。要加的只有：只給 Firefox 用的 PulseAudio null sink；Chromium 的 autoplay flag 與 Firefox 的 `media.autoplay.default=0`（或出聲前先 `userEvent.click()`）；Firefox 的 H.264 與 AAC 需要 libavcodec（官方 image 已有）。
- 真正的 Safari 要另開一個 serial、headed 的 macOS job，在 private repo 上每分鐘約 $0.062，只跑一小組測試，job 開始時先檢查音訊裝置。
