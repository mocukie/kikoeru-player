// 拋棄式 spike（#18，沿用 #17）：Worker 內共用的工具。libav.js 一律以 noworker（direct）模式載入，比照 Engine 的設計。
export const VER = "6.10.9.0";
export const VARIANT = "kikoeru-af";
const glueCache = {};

// 以 factory 選項載入：可以傳入預先編譯好的 WebAssembly.Module（instantiateWasm hook），避免重複編譯
export async function createLibAV({ variant = VARIANT, module = null } = {}) {
  const { default: LibAV } = await import(`/dist/libav-${VER}-${VARIANT}.mjs`);
  const glue = glueCache[variant] ??= (await import(`/dist/libav-${VER}-${variant}.wasm.mjs`)).default;
  const wasmurl = `/dist/libav-${VER}-${variant}.wasm.wasm`;
  const factory = (o) => glue({
    ...o, wasmurl,
    ...(module && { instantiateWasm(imports, cb) { WebAssembly.instantiate(module, imports).then(cb); return {}; } }),
  });
  const libav = await LibAV.LibAV({ noworker: true, factory, variant });
  return libav;
}

export async function fileSize(url) {
  const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
  await r.arrayBuffer();
  return +r.headers.get("Content-Range").split("/")[1];
}

// block reader device：每次 cache miss 發一個 Range 請求（chunk 大小、延遲可調），可隨時 abort 掛起中的請求
export async function openReader(libav, name, url, { chunk = 64 * 1024, lat = 0 } = {}) {
  const size = await fileSize(url);
  const st = { size, reads: 0, bytes: 0, pending: 0, ac: null, lat, chunk, onPending: null, fetchMs: 0 };
  libav.readers ??= {};
  libav.readers[name] = st;
  libav.onblockread = async (n, pos, len) => {
    const r0 = libav.readers[n];
    const ac = new AbortController();
    r0.ac = ac;
    r0.pending++;
    r0.onPending?.();
    const t0 = performance.now();
    try {
      const end = Math.min(r0.size, pos + Math.max(len, r0.chunk)) - 1;
      const resp = await fetch(`${url0(libav, n)}?lat=${r0.lat}`, { headers: { Range: `bytes=${pos}-${end}` }, signal: ac.signal });
      const buf = new Uint8Array(await resp.arrayBuffer());
      r0.reads++; r0.bytes += buf.length;
      await libav.ff_block_reader_dev_send(n, pos, buf);
    } finally { r0.pending--; r0.fetchMs += performance.now() - t0; }
  };
  st.url = url;
  await libav.mkblockreaderdev(name, size);
  return st;
}
const url0 = (libav, n) => libav.readers[n].url;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();

export function fnv(u8) {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
export const pktSig = (p) => `${p.stream_index}:${p.pts}:${p.data.length}:${fnv(p.data)}`;

export function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
export function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }

// 時間（秒）→ AV_TIME_BASE 的 (lo, hi)
export function tsLoHi(sec) {
  const us = Math.round(sec * 1e6);
  return [us % 0x100000000 | 0, Math.floor(us / 0x100000000)];
}

export function errInfo(e) {
  if (e == null) return null;
  if (typeof e === "number") return `errno ${e}`;
  return `${e.name ?? "?"}: ${e.message ?? e}`;
}
