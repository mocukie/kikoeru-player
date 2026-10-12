# kikoeru-player

kikoeru 前端使用的 headless 播放引擎：在瀏覽器內讀取、demux、解碼與輸出音訊與影片，只提供 API 與事件，畫面由使用它的 App 負責。

## Language

**Engine**:
本 repo 交付的 headless 播放引擎套件，不含任何 UI。
_Avoid_: player（單獨使用時）、SDK

**App**:
使用 Engine 並負責畫面、外掛字幕與 Media Session 的程式，例如 kikoeru 的 webui。
_Avoid_: host、client、前端（單獨使用時）

**Demo 頁**:
本 repo 內供手動試播、實機鎖屏清單與 Playwright 測試使用的頁面，地位是開發工具，不是 App。
_Avoid_: example、playground、spike
