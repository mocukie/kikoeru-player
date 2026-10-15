// 平台判斷：只用來選預設值（audioBuffer、limits），不對外公開。

/** iOS 與 iPadOS 合為 `'ios'`。 */
export type Platform = 'ios' | 'android' | 'desktop';

/** `detectPlatform()` 需要的 `navigator` 欄位。 */
export interface NavigatorLike {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
}

/**
 * 依 UA 與觸控點數判斷平台。iPadOS 的 Safari 預設以 Mac 的 UA 回報，所以 Mac 的 UA 有多點觸控
 * （`maxTouchPoints > 1`）時視為 iOS／iPadOS；其他有觸控的桌面（例如 Windows 筆電）仍是桌面。
 */
export function detectPlatform(navigator: NavigatorLike | undefined): Platform {
  if (!navigator) return 'desktop';
  const { userAgent, maxTouchPoints = 0 } = navigator;
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  if (userAgent.includes('Macintosh') && maxTouchPoints > 1) return 'ios';
  return 'desktop';
}
