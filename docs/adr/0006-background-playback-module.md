# 背景播放走選配模組，靜音 anchor 在所有平台都啟用

只靠 Web Audio 輸出時，OS 不會把頁面當成媒體播放器：iOS 的 WebKit 在背景會中斷 `AudioContext`，靜音鍵也會讓它沒聲音；Android Chrome 把 `AudioContext` 當成 ambient player，不取得 audio focus，沒有媒體通知，也沒有讓 Chrome 在背景存活的 foreground service。kikoeru 播放器 spike 在 iPhone 與 Samsung 通過鎖屏清單的組合是 `navigator.audioSession.type = "playback"` 加上一段循環播放的靜音 `<audio>`（**靜音 anchor**）。

這段邏輯做成**背景播放模組**：同一個套件的另一個 entry `kikoeru-player/background`，`attachBackgroundPlayback(engine, options?)`，只用 Engine 的公開 API（`beforeaudiostart`、`statechange`、`play()`／`pause()`）實作，core 不碰 DOM 的 `<audio>`。模組在所有平台都啟用，不偵測 UA。

## Considered Options

- **放進 core（`createEngine` 的選項）**：core 要持有 DOM element 與 `navigator.audioSession` 這類頁面層級的狀態，也就難以在 Worker 或測試環境中單獨使用。做成只依賴公開 API 的模組，也能證明 core 提供的 hook 足夠。
- **交給 App**：Demo 頁要跑實機鎖屏清單，本身就需要這段邏輯，放在 App 會讓 Demo 頁與 kikoeru 各寫一份，平台的眉角也會散在兩處。
- **anchor 只在 Android 啟用**：iOS 上 media element 會優先成為 Now Playing，遠端指令才會轉給 App 的 Media Session handler；只有 `AudioContext` 時只剩 play／pause，而且 WebKit 直接 suspend／resume context，不呼叫 handler。桌面版 Chrome 的媒體鍵與全域媒體控制同樣需要 media element。偵測 UA 也容易出錯。
- **App 提供 anchor 的音檔**：沒有實際需求。模組自己產生 5 秒、8 kHz、mono 的靜音 WAV blob（5 秒是 Android 取得 full audio focus 的門檻），`loop`、`volume = 0.0001`，不掛進 DOM。

## Consequences

- `audioSession.type` 只在 `navigator.audioSession` 存在時、於每次 `beforeaudiostart` 設定（一定在 context 出聲之前）；detach 時還原成 attach 前的值。
- anchor 跟著播放意圖 `paused` 走，不看 `state`：loading、seeking、buffering 與曲目之間都持續播放，避免 Android 通知閃爍、iOS 的 Now Playing 被搶走，背景接下一首時也不需要 gesture。第一次 `play()` 在 `beforeaudiostart` 內同步呼叫以取得 gesture 授權；`paused` 仍為 true 時取得授權後立刻 `pause()`。
- 不是模組自己觸發的 anchor `pause`／`play`（Android 來電、audio focus 被搶、沒有 handler 時的通知與鎖屏按鍵）雙向鏡像為 `engine.pause()`／`engine.play()`，不另外通知 App，`statechange.reason` 為 `'command'`。
- anchor 啟動失敗不是 Engine 的錯誤，也不影響播放；下一次 `beforeaudiostart` 或 `paused` 變成 false 時再試，經 `options.log`（scope `'background'`）記錄。
- core 的 API 約定因此新增兩條：`ended` 時 `paused` 維持 false；`play()`／`pause()` 改變 `paused` 時，在呼叫內同步發出 `statechange`。
- App 的 CSP 若限制 `media-src`，要允許 `blob:`。Media Session 的 handler、metadata 與 position 仍由 App 負責。
