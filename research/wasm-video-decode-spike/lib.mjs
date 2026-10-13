// 拋棄式 spike（#20）：Worker（或 Node）內共用的工具。libav.js 一律以 noworker（direct）模式載入，比照 Engine 的設計。
// 檔名規則（build.sh 產生）：libav-<VER>-<variant>-<flavor>[-noasy].<wasm|thr>.{mjs,wasm}，frontend 為 libav-<VER>-<variant>.mjs。
export const VER = "6.10.9.0";
const isNode = typeof process !== "undefined" && !!process.versions?.node && typeof window === "undefined" && typeof WorkerGlobalScope === "undefined";
export const env = { base: "/dist", media: "/media" };

export async function loadMedia(name) {
  if (isNode) {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(`${env.media}/${name}`));
  }
  return new Uint8Array(await (await fetch(`${env.media}/${name}`)).arrayBuffer());
}

// variant: kikoeru-af／kikoeru-afv／kikoeru-dav1d；flavor: oz／o3／o3s；noasy：不開 Asyncify 的 link；target: wasm／thr
export async function createLibAV({ variant = "kikoeru-dav1d", flavor = "oz", noasy = false, target = "wasm", module = null } = {}) {
  const name = `libav-${VER}-${variant}-${flavor}${noasy ? "-noasy" : ""}.${target}`;
  const base = isNode ? env.base : new URL(env.base + "/", self.location.href).href;
  const { default: LibAV } = await import(`${base}/libav-${VER}-${variant}.mjs`);
  const glue = (await import(`${base}/${name}.mjs`)).default;
  const wasmurl = `${base}/${name}.wasm`;
  const factory = (o) => glue({
    ...o, wasmurl,
    ...(isNode && { locateFile: () => wasmurl.replace(/^file:\/\//, "") }),
    ...(module && { instantiateWasm(imports, cb) { WebAssembly.instantiate(module, imports).then((i) => cb(i)); return {}; } }),
  });
  const t0 = performance.now();
  const libav = await LibAV.LibAV({ noworker: true, factory, variant });
  libav.loadMs = performance.now() - t0;
  libav.wasmName = name;
  return libav;
}

// 整個檔案放進 MEMFS 再 demux，取出第一條影片軌的所有封包（量測只看解碼，不含 I/O）
export async function demuxAll(file) {
  const dm = await createLibAV({ variant: "kikoeru-af", flavor: "oz" });
  await dm.writeFile(file, await loadMedia(file));
  const [fmt, streams] = await dm.ff_init_demuxer_file(file);
  const vs = streams.find((s) => s.codec_type === dm.AVMEDIA_TYPE_VIDEO);
  const codecpar = await dm.ff_copyout_codecpar(vs.codecpar);
  const pkt = await dm.av_packet_alloc();
  const [, all] = await dm.ff_read_frame_multi(fmt, pkt, { limit: 1 << 30 });
  const packets = all[vs.index] ?? [];
  await dm.av_packet_free_js(pkt);
  await dm.avformat_close_input_js(fmt);
  dm.terminate?.();
  return { codecpar, packets, timeBase: [vs.time_base_num, vs.time_base_den] };
}

export function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? null; }
export function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? null; }
export const stat = (a) => a.length ? {
  n: a.length, mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2),
  p50: +median(a).toFixed(2), p95: +pct(a, 0.95).toFixed(2), p99: +pct(a, 0.99).toFixed(2), max: +Math.max(...a).toFixed(2),
} : null;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
