# v1 只驗證桌面 Chromium 與 Firefox，Safari 與行動瀏覽器延後

v1（`0.1.0`～`1.0.0`）只支援並驗證近兩年的桌面 Chromium 與 Firefox。桌面 Safari、iOS Safari、Android Chrome 延後到另一張主 issue（短代號 `engine-platforms`），在那之前不宣稱支援，也不擋發版。這兩個桌面瀏覽器都能用 Playwright 在 CI 與本機自動測試，agent 能自己驗證。Safari 沒有可用的 Playwright 自動化（Linux 的 WebKit 媒體走 GStreamer，不代表 Safari），手機只能靠實機，每次發版都要花大量人工。

延後不是放棄：Safari 與手機仍是之後的目標平台。為它們做的設計與程式碼都保留，包括 Asyncify 的選擇（[ADR-0001](0001-libavjs-asyncify.md)）、每次 load 重建 Worker（[ADR-0002](0002-media-worker-per-load.md)）、Safari AV1 回報 `'platform'`（[ADR-0003](0003-decode-paths.md)）、iOS／Android 的平台預設值與 `interrupted` 的處理（[ADR-0004](0004-audio-output.md)），以及背景播放模組（[ADR-0006](0006-background-playback-module.md)）。在這些平台上可能可以播放，但沒有驗證。

## Considered Options

- **只延到 `1.0.0` 前一次做完**：手機與 Safari 的人工驗證時間沒有減少，只是延後，`1.0.0` 仍被擋住。
- **保留桌面 Safari，以 macOS runner 的排程 job 自動化**：要另外維護 webdriverio 與 macOS runner 的音訊裝置，而 Safari 的實機清單仍要人工跑，v1 先不承擔。
- **刪除行動裝置相關的程式碼**：之後要加回來的成本高；背景播放模組在桌面也有用（桌面 Chrome 的媒體鍵需要 media element）。

## Consequences

- 發版只看 CI 的 `check` 與 `browser`（Chromium、Firefox）。實機清單只在 `1.0.0` 前跑一次桌面部分（共同項目與 Firefox）；Safari 與手機的段落在 v1 不執行（[測試規範「實機清單」](../testing.md#實機清單)）。
- ADR-0004、ADR-0006 中「待實機確認」的假設（例如 iOS 上 `resume()` 是否需要 gesture、`setPositionState()` 能否蓋過 anchor）在 v1 維持未確認，由 `engine-platforms` 驗證；結果可能推翻這些 ADR。
- kikoeru 在 Safari 與行動瀏覽器上改用本 Engine 的時機由 kikoeru 決定，或等 `engine-platforms` 完成。
