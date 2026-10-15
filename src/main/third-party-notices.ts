import type { ThirdPartyNotice } from './types.js';

/**
 * Engine 內含的第三方元件（FFmpeg 的 libav.js build，LGPL-2.1-or-later）的授權聲明與原始碼位置，
 * 供 App 的「關於」頁顯示。內容在發版的 build 時寫入。
 */
// 佔位值：發版流程（#46）的 build 會寫入 wasm Release 的原始碼 URL 與聲明。
export const thirdPartyNotices: readonly ThirdPartyNotice[] = Object.freeze([]);
