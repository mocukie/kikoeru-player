# kikoeru-player

kikoeru 前端使用的 headless 播放引擎：在瀏覽器內讀取、demux、解碼與輸出音訊與影片，只提供 API 與事件，畫面由使用它的 App 負責。

## Language

每個名詞以「中文（English）」列出：文件與討論用中文，程式命名（型別、函式、變數、事件）用英文。

### 角色

**Engine**:
本 repo 交付的 headless 播放引擎套件，不含任何 UI。
_Avoid_: player（單獨使用時）、SDK

**App**:
使用 Engine 並負責畫面、外掛字幕與 Media Session 的程式，例如 kikoeru 的 webui。
_Avoid_: host、client、前端（單獨使用時）

**Demo 頁（Demo page）**:
本 repo 內供手動試播、實機鎖屏清單與 Playwright 測試使用的頁面，地位是開發工具，不是 App。
_Avoid_: example、playground、spike

### 媒體與軌道

**來源（Source）**:
Engine 讀取位元組的對象，例如一個 HTTP URL、一段記憶體資料或一個本機檔案。
_Avoid_: 檔案、file、input

**媒體（Media）**:
一次載入所開啟的主來源，連同其軌道與外掛音軌的整體。
_Avoid_: 檔案、file、作品、work（作品是 kikoeru 的概念）

**軌道（Track）**:
媒體內一條可單獨選用的音訊、影片或字幕資料。
_Avoid_: stream（FFmpeg 的用語，只在對接 libavformat 的程式內使用）

**外掛音軌（External audio track）**:
來自另一個來源、用來取代容器內音軌並對齊同一條媒體時間軸的音軌。
_Avoid_: 外部音軌、配音軌、dub track、secondary audio

**音軌 offset（Audio offset）**:
某條音軌相對於媒體時間軸的位移秒數，正值表示聲音較晚出現。
_Avoid_: 延遲、音畫同步、delay、sync offset

**媒體時間軸（Media timeline）**:
以媒體第一個可播放的 sample 為 0 的時間軸；Engine 對外的所有時間都在這條軸上。
_Avoid_: 時間戳、pts、timestamp（指對外時間時）

### 播放控制

**指令（Command）**:
App 要求 Engine 改變播放的動作，例如載入、播放、seek、切軌；依呼叫順序執行。
_Avoid_: 操作、request、action

**取代（Supersede）**:
尚未完成的指令被較新的同類指令作廢，例如連續 seek 只執行最後一個。
_Avoid_: 取消、cancel（取消指由 App 主動中止）

**播放意圖（Playback intent）**:
使用者要播還是要停，與 Engine 實際所處的狀態分開記錄；程式中以 boolean `paused` 表示（true 表示要停），沿用 `HTMLMediaElement.paused`。
_Avoid_: 播放狀態、state（指意圖時）

**音訊時鐘（Audio clock）**:
Engine 唯一的時鐘，指此刻聽到的聲音在媒體時間軸上的位置；沒有音軌或音訊已結束時，以靜音繼續推進到媒體結尾。影片與字幕都依它對齊。
_Avoid_: 主時鐘、master clock、系統時間

**變速（Playback rate）**:
不改變音高的播放速度（time stretch），程式中以 `playbackRate` 表示，沿用 `HTMLMediaElement.playbackRate`。改變時已送出的聲音照舊速度播完（drain），不中斷播放。
_Avoid_: 倍速、speed、tempo（`tempo` 只指 `atempo` filter 的參數）

**time map**:
media Worker 送出的音訊與媒體時間軸的對應：輸出依速度分段，每段記下開頭的媒體時間與速度，音訊時鐘依它把播出的 sample 換算成媒體時間。
_Avoid_: 時間對應表、timeline map

**卡住（Stall）**:
想播放卻在時限內等不到資料的情況，Engine 會自動嘗試恢復。
_Avoid_: 凍結、freeze、hang、lag

**預讀（Readahead）**:
在播放位置之後、事先抓取來源資料，讓網路變慢時仍能繼續播放；以秒數為目標，記憶體上限由 Engine 的設定決定。
_Avoid_: 預載、緩衝、preload、prefetch、buffer（指這個動作時）

**重新載入（Reload）**:
以同一份媒體重新開檔，保留位置、播放意圖、選軌、外掛音軌與音軌 offset。
_Avoid_: 重試、retry、refresh

### 字幕

**內嵌字幕（Embedded subtitle）**:
媒體容器內的字幕軌，由 Engine 隨讀取進度送出 cue。
_Avoid_: 內建字幕、軟字幕、internal subtitle、soft subtitle

**外掛字幕（External subtitle）**:
獨立於媒體的字幕檔，由 App 自行取得與解析，不經過 Engine。
_Avoid_: 外部字幕、sidecar subtitle

**Cue**:
內嵌字幕中一段有起訖時間的字幕資料。
_Avoid_: 字幕行、subtitle line、event（ASS 的 event 另指原文中的一行）

### 背景播放

**背景播放模組（Background playback module）**:
Engine 套件內的選配模組，讓 OS 把 App 當成正在播放的媒體播放器，使播放能在背景、鎖屏與系統媒體控制下持續；由 App 決定是否使用。
_Avoid_: 行動裝置模組、mobile support、keepalive

**靜音 anchor（Silent anchor）**:
背景播放模組播放的一段靜音 `<audio>`，只用來向 OS 宣告「正在播放媒體」，媒體的聲音不經過它。
_Avoid_: keepalive、dummy audio、假音訊
