// test:browser 與 e2e 開始前檢查 CI 組的測試媒體（README「常用指令」、docs/testing.md「測試媒體」）。
// 缺少或與產生 script 不符時停下並提示 pnpm media:gen，不自動產生。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const mediaDir = new URL('../test/media/', import.meta.url);

/** 與 gen-media.sh 寫入 out/.stamp 的內容相同：兩個 script 的 `sha256sum` 輸出。 */
async function expectedStamp(): Promise<string> {
  const lines = await Promise.all(
    ['gen-media.sh', 'gen-subs.py'].map(async (name) => {
      const hash = createHash('sha256')
        .update(await readFile(new URL(name, mediaDir)))
        .digest('hex');
      return `${hash}  ${name}\n`;
    }),
  );
  return lines.join('');
}

async function readStamp(): Promise<string | undefined> {
  try {
    return await readFile(new URL('out/.stamp', mediaDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const stamp = await readStamp();
if (stamp === undefined) {
  console.error('找不到 CI 組的測試媒體（test/media/out/），請先執行 pnpm media:gen。');
  process.exit(1);
}
if (stamp !== (await expectedStamp())) {
  console.error('測試媒體的產生 script 已變更，請重新執行 pnpm media:gen。');
  process.exit(1);
}
