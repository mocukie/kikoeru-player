// 拋棄式 spike（#17）：靜態 server。HTTP Range、可設定延遲（?lat=毫秒）、.wasm 用 application/wasm、不快取。
// /dist/* → libav.js dist 目錄，/media/* → 媒體目錄，其餘 → 本目錄的 harness 檔案。
// ?coi=1 的頁面帶 COOP/COEP（只為了在 Chromium 用 measureUserAgentSpecificMemory）。
import { createServer } from "node:http";
import { open, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript",
  ".wasm": "application/wasm", ".json": "application/json", ".ts": "text/plain",
};

export function startServer({ dist, media, port = 0 }) {
  const roots = { dist, media };
  const stats = { requests: 0, aborted: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const [, top, ...rest] = url.pathname.split("/");
    const root = roots[top] ?? HERE;
    const rel = roots[top] ? rest.join("/") : [top, ...rest].join("/");
    const file = join(root, normalize("/" + rel));
    stats.requests++;
    const headers = { "Cache-Control": "no-store", "Accept-Ranges": "bytes",
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" };
    if (url.searchParams.get("coi") === "1" || req.headers.referer?.includes("coi=1")) {
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
      headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    }
    let st;
    try { st = await stat(file); if (!st.isFile()) throw 0; } catch { res.writeHead(404, headers).end(); return; }
    let start = 0, end = st.size - 1, status = 200;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (m) {
      start = +m[1]; end = m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1; status = 206;
      if (start >= st.size) { res.writeHead(416, { ...headers, "Content-Range": `bytes */${st.size}` }).end(); return; }
      headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    }
    headers["Content-Length"] = end - start + 1;
    const lat = +(url.searchParams.get("lat") ?? 0);
    let closed = false;
    req.on("close", () => { if (!res.writableEnded) { closed = true; stats.aborted++; } });
    if (lat > 0) await new Promise((r) => { const t = setTimeout(r, lat); req.on("close", () => { clearTimeout(t); r(); }); });
    if (closed) return;
    const fh = await open(file);
    try {
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      res.writeHead(status, headers).end(req.method === "HEAD" ? undefined : buf);
    } finally { await fh.close(); }
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, port: server.address().port, stats })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dist, media, port = "8417"] = process.argv.slice(2);
  const { port: p } = await startServer({ dist, media, port: +port });
  console.log(`http://127.0.0.1:${p}/`);
}
