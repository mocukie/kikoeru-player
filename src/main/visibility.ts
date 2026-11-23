// 頁面的可見性（`suspendVideoWhenHidden`）：`document.hidden` 與 `visibilitychange`。

import type { PageVisibility } from './deps.js';

/** 以 `document` 實作的 `PageVisibility`；沒有 `document` 時永遠可見。 */
export function documentVisibility(): PageVisibility {
  if (typeof document === 'undefined') {
    return { hidden: false, subscribe: () => () => undefined };
  }
  return {
    get hidden() {
      return document.hidden;
    },
    subscribe(listener) {
      document.addEventListener('visibilitychange', listener);
      return () => {
        document.removeEventListener('visibilitychange', listener);
      };
    },
  };
}
