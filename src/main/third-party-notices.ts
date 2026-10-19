import type { ThirdPartyNotice } from './types.js';

/**
 * Engine 內含的第三方元件的授權聲明與原始碼位置，供 App 的「關於」頁顯示。目前只有一項：FFmpeg 的
 * libav.js build（`license` 為 `'LGPL-2.1-or-later'`，`sourceUrl` 是內附 wasm 對應的 wasm Release，
 * `noticeText` 與套件的 `NOTICE` 相同）。
 *
 * 內容在 `pnpm build` 時寫入；直接使用原始碼（本 repo 的 Demo 頁與測試）時是空陣列。
 */
// 佔位值：scripts/package.ts 在 build 時以 wasm Release 的內容取代 dist/main/third-party-notices.js。
export const thirdPartyNotices: readonly ThirdPartyNotice[] = Object.freeze([]);
