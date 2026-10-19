// `/media/*` 的故障注入（docs/testing.md「HTTP 來源與故障注入」）。故障由 query 參數控制：
//
// - `fault=<規則>[,<規則>…]`（`fault` 也可以重複出現）：
//   - `<status>@<n>`：第 n 個請求（從 1 起算）回應 `<status>`，body 是空的；`200` 表示忽略 Range、回應整個檔案。
//   - `stall@<位置>`：第一個涵蓋檔案位置 `<位置>` 的回應送到那裡就停住，連線保持開著，直到 client 中止。
//   - `drop@<位置>`：同上，但在那裡切斷連線（client 看到網路錯誤）。
//   - 規則結尾加 `+`（URL 中寫成 `%2B`）表示持續：`503@2+` 是第 2 個以後的每個請求，`drop@1MB+` 是每個涵蓋
//     該位置的回應。
//   - 位置是 bytes，可加單位 `KB`、`MB`（1024 進位），例如 `500KB`。
// - `delay=<ms>`：每個回應送出 header 之前先等 `<ms>` 毫秒。
//
// 請求的計數與「第一個」以完整的 URL（含 query）區分，測試在 query 加上不重複的參數（例如 `id=…`）就互不影響。
// 有故障參數的回應一律 `Cache-Control: no-store`、不帶 ETag，避免瀏覽器以快取回應而沒有打到 server。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants as http2 } from 'node:http2';
import type { Connect } from 'vite';

type Response = ServerResponse | (ServerResponse & { stream: { close(code: number): void } });

interface StatusRule {
  kind: 'status';
  status: number;
  request: number;
  persistent: boolean;
}

interface CutRule {
  kind: 'stall' | 'drop';
  /** 規則原本的寫法，用來記住已經觸發過的規則。 */
  spec: string;
  offset: number;
  persistent: boolean;
}

type Rule = StatusRule | CutRule;

export interface Faults {
  rules: Rule[];
  delay: number;
}

/** 每個 URL 的狀態：請求數，以及已經觸發過的非持續規則。 */
const states = new Map<string, { requests: number; fired: Set<string> }>();

const units: Record<string, number> = { '': 1, B: 1, KB: 1024, MB: 1024 * 1024 };

/** 解析 query 的故障參數；沒有任何故障時回傳 null，格式錯誤時丟出指出該參數的 Error。 */
export function parseFaults(query: URLSearchParams): Faults | null {
  const specs = query.getAll('fault').flatMap((v) => v.split(',').filter(Boolean));
  const delayParam = query.get('delay');
  if (specs.length === 0 && delayParam === null) return null;
  const rules = specs.map(parseRule);
  const delay = delayParam === null ? 0 : Number(delayParam);
  if (!Number.isFinite(delay) || delay < 0) throw new Error(`無法解析的 delay=${delayParam ?? ''}`);
  return { rules, delay };
}

function parseRule(spec: string): Rule {
  const status = /^(\d{3})@(\d+)(\+?)$/.exec(spec);
  if (status) {
    return {
      kind: 'status',
      status: Number(status[1]),
      request: Number(status[2]),
      persistent: status[3] === '+',
    };
  }
  const cut = /^(stall|drop)@(\d+)(B|KB|MB)?(\+?)$/i.exec(spec);
  if (cut) {
    return {
      kind: cut[1]?.toLowerCase() === 'stall' ? 'stall' : 'drop',
      spec,
      offset: Number(cut[2]) * (units[cut[3]?.toUpperCase() ?? ''] ?? 1),
      persistent: cut[4] === '+',
    };
  }
  throw new Error(`無法解析的 fault=${spec}`);
}

/**
 * 在 `serve` 前面套上故障注入。`serve` 以 `send` 提供檔案：它設定好 status 與 Content-Range 後才寫 body，
 * 所以 stall／drop 在 `res.write` 依已送出的 bytes 截斷。
 */
export function withFaults(
  serve: (req: IncomingMessage, res: ServerResponse, cacheable: boolean) => void,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    let faults: Faults | null;
    try {
      faults = parseFaults(url.searchParams);
    } catch (error) {
      res.statusCode = 400;
      res.end(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!faults) {
      serve(req, res, true);
      return;
    }
    const key = req.url ?? '/';
    let state = states.get(key);
    if (!state) {
      state = { requests: 0, fired: new Set() };
      states.set(key, state);
    }
    state.requests++;
    const { requests, fired } = state;
    const active = faults;

    const respond = () => {
      if (res.destroyed || res.writableEnded) return;
      res.setHeader('Cache-Control', 'no-store');
      const status = active.rules.find(
        (r): r is StatusRule =>
          r.kind === 'status' && (r.persistent ? requests >= r.request : requests === r.request),
      );
      if (status && status.status !== 200) {
        res.statusCode = status.status;
        res.end();
        return;
      }
      if (status) delete req.headers.range;
      const cuts = active.rules.filter((r): r is CutRule => r.kind !== 'status');
      if (cuts.length > 0) interceptBody(res, cuts, fired);
      serve(req, res, false);
    };
    if (active.delay > 0) setTimeout(respond, active.delay);
    else respond();
  };
}

/** 依 `cuts` 在回應的 body 送到指定的檔案位置時停住或斷線。 */
function interceptBody(res: Response, cuts: CutRule[], fired: Set<string>): void {
  const write = res.write.bind(res) as (chunk: Uint8Array, callback?: () => void) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  /** 回應的 body 在檔案中的起點與結尾（含），第一次寫入時由 Content-Range 決定。 */
  let span: { start: number; end: number } | null = null;
  let sent = 0;
  let cut = false;

  const spanOf = () => {
    const match = /bytes (\d+)-(\d+)\//.exec(String(res.getHeader('Content-Range') ?? ''));
    if (match) return { start: Number(match[1]), end: Number(match[2]) };
    return { start: 0, end: Number(res.getHeader('Content-Length') ?? 0) - 1 };
  };

  res.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (cut) return true;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    span ??= spanOf();
    const { start, end: last } = span;
    const position = start + sent;
    // 非持續的規則只對第一個涵蓋該位置的回應生效。
    const rule = cuts.find(
      (r) =>
        start <= r.offset &&
        r.offset <= last &&
        position + bytes.length > r.offset &&
        (r.persistent || !fired.has(r.spec)),
    );
    if (!rule) {
      sent += bytes.length;
      return write(bytes, rest.find((r) => typeof r === 'function') as (() => void) | undefined);
    }
    cut = true;
    fired.add(rule.spec);
    const after = () => {
      if (rule.kind === 'drop') destroy(res);
    };
    const head = bytes.subarray(0, Math.max(0, rule.offset - position));
    if (head.length > 0) {
      write(head, after);
    } else {
      res.flushHeaders();
      after();
    }
    // stall：之後的 body 與 end 都吞掉，連線保持開著。
    return true;
  }) as typeof res.write;

  res.end = ((...args: unknown[]) => (cut ? res : end(...args))) as typeof res.end;
}

/** 切斷連線：HTTP/2（Vite 的 HTTPS dev server）只重設這個 stream，HTTP/1 關掉 socket。 */
function destroy(res: Response): void {
  if ('stream' in res) res.stream.close(http2.NGHTTP2_INTERNAL_ERROR);
  else res.destroy();
}
