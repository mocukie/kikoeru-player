// 拋棄式 spike（#17）：read 被中止（onblockread reject）後，同一個 demuxer 能否 seek 並繼續讀。
// 每個（容器 × 情境 × 恢復方式）都用新的 instance，跟沒有中止的參考結果逐封包比對（stream、pts、大小、FNV hash）。
import { createLibAV, openReader, tsLoHi, pktSig, errInfo, now, sleep } from "./lib.mjs";

const STALL = 600000;  // 掛起：server 延遲 10 分鐘，等我們 abort
const AVSEEK_FLAG_BACKWARD = 1;

async function setup(module, file, lat, chunk) {
  const lib = await createLibAV({ module });
  const rd = await openReader(lib, "f", `/media/${file}`, { lat, chunk });
  return { lib, rd };
}
async function open(lib) {
  const [fmt, streams] = await lib.ff_init_demuxer_file("f");
  const pkt = await lib.av_packet_alloc();
  return { fmt, streams, pkt };
}
// 讀 n 個封包（逐一呼叫，方便比對）
async function readN(lib, fmt, pkt, n) {
  const sigs = [];
  while (sigs.length < n) {
    const [res, ps] = await lib.ff_read_frame_multi(fmt, pkt, { limit: 1, unify: true });
    for (const p of ps[0] ?? []) sigs.push(pktSig(p));
    if (res !== -6) return { res, sigs };
  }
  return { res: 0, sigs };
}
async function seek(lib, fmt, sec) {
  const [lo, hi] = tsLoHi(sec);
  return lib.av_seek_frame(fmt, -1, lo, hi, AVSEEK_FLAG_BACKWARD);
}
async function pbState(lib, fmt) {
  const pb = await lib.AVFormatContext_pb(fmt);
  return { error: await lib.AVIOContext_error(pb), eof: await lib.AVIOContext_eof_reached(pb) };
}
// 讓下一次 cache miss 掛起，掛起 delay 毫秒後 abort
function armAbort(rd, delay = 30) {
  rd.lat = STALL;
  const st = { aborted: false, at: 0 };
  rd.onPending = () => { rd.onPending = null; setTimeout(() => { st.at = now(); st.aborted = true; rd.ac.abort(); }, delay); };
  return st;
}
function disarm(rd, lat) { rd.lat = lat; rd.onPending = null; }

const STRATEGIES = {
  none: async () => {},
  dev: async (lib) => { await lib.ff_block_reader_dev_send("f", 0, new Uint8Array(0)); },
  pb: async (lib, fmt) => { const pb = await lib.AVFormatContext_pb(fmt); await lib.AVIOContext_error_s(pb, 0); await lib.AVIOContext_eof_reached_s(pb, 0); },
  devpb: async (lib, fmt) => { await STRATEGIES.dev(lib); await STRATEGIES.pb(lib, fmt); },
};

export async function run({ files = ["ab.mkv", "ab.mp4", "ab.wav", "ab.mp3"], lat = 2, chunk = 64 * 1024, warm = 40, target = 30, n = 60 } = {}, progress) {
  const module = await WebAssembly.compileStreaming(fetch("/dist/libav-6.10.9.0-kikoeru-af.wasm.wasm"));
  const out = {};
  for (const file of files) {
    const R = out[file] = {};
    // 參考：不中止，warm → seek(target) → n 個封包；另外記錄開頭連續 3000 個封包，用來判斷「不 seek 直接續讀」是否接得上
    {
      const { lib, rd } = await setup(module, file, lat, chunk);
      const { fmt, pkt } = await open(lib);
      const all = await readN(lib, fmt, pkt, 3000);
      R.refAll = all.sigs;
      const r2 = await setup(module, file, lat, chunk);
      const o2 = await open(r2.lib);
      await readN(r2.lib, o2.fmt, o2.pkt, warm);
      await seek(r2.lib, o2.fmt, target);
      R.ref = (await readN(r2.lib, o2.fmt, o2.pkt, n)).sigs;
    }
    const cmp = (sigs) => {
      let match = 0; while (match < sigs.length && sigs[match] === R.ref[match]) match++;
      return match;
    };
    R.cases = [];
    for (const scenario of ["read", "seek"]) {
      for (const strategy of ["none", "dev", "pb", "devpb", "devpb-noseek", "reopen"]) {
        progress?.(`${file} ${scenario} ${strategy}`);
        const c = { scenario, strategy };
        try {
          const { lib, rd } = await setup(module, file, lat, chunk);
          let { fmt, pkt } = await open(lib);
          await readN(lib, fmt, pkt, warm);
          const ab = armAbort(rd);
          const t0 = now();
          try {
            if (scenario === "read") {
              const r = await lib.ff_read_frame_multi(fmt, pkt, { limit: 8 * 1024 * 1024 });
              c.abortCall = `resolved res=${r[0]}`;
            } else {
              const r = await seek(lib, fmt, 45);
              c.abortCall = `seek resolved ret=${r}`;
              c.abortedInSeek = ab.aborted;
              if (!ab.aborted) {  // seek 本身沒有讀網路：改在 seek 後第一個 read 中止
                const r2 = await lib.ff_read_frame_multi(fmt, pkt, { limit: 8 * 1024 * 1024 });
                c.abortCall += `; read resolved res=${r2[0]}`;
              }
            }
          } catch (e) {
            c.abortCall = `rejected ${errInfo(e)}`;
            c.rejectMs = +(now() - (ab.at || t0)).toFixed(1);
          }
          c.aborted = ab.aborted;
          disarm(rd, lat);
          c.pbAfterAbort = await pbState(lib, fmt);
          if (strategy === "reopen") {
            await lib.avformat_close_input_js(fmt);
            await STRATEGIES.dev(lib);
            const t1 = now();
            ({ fmt, pkt } = await open(lib));
            c.reopenMs = +(now() - t1).toFixed(1);
          } else {
            await STRATEGIES[strategy.replace("-noseek", "")](lib, fmt);
          }
          if (strategy === "devpb-noseek") {
            const r = await readN(lib, fmt, pkt, n);
            const idx = R.refAll.indexOf(r.sigs[0]);
            let ok = idx >= 0 ? 0 : -1;
            if (idx >= 0) while (ok < r.sigs.length && R.refAll[idx + ok] === r.sigs[ok]) ok++;
            c.result = { res: r.res, got: r.sigs.length, contiguousFromRefIndex: idx, contiguousMatch: ok };
          } else {
            let seekRet;
            try { seekRet = await seek(lib, fmt, target); } catch (e) { seekRet = `threw ${errInfo(e)}`; }
            let r;
            try { r = await readN(lib, fmt, pkt, n); } catch (e) { r = { res: `threw ${errInfo(e)}`, sigs: [] }; }
            c.result = { seekRet, res: r.res, got: r.sigs.length, matchRef: cmp(r.sigs), of: n };
            // 讀到檔尾：殘留的 pb->error 會不會把 EOF 變成錯誤
            if (strategy !== "none") {
              const dur = (await lib.AVFormatContext_duration(fmt)) / 1e6 + (await lib.AVFormatContext_durationhi(fmt)) * 4294.967296;
              try {
                await seek(lib, fmt, dur - 2);
                const t = await readN(lib, fmt, pkt, 5000);
                c.tail = { res: t.res === -541478725 ? "EOF" : t.res, got: t.sigs.length };
              } catch (e) { c.tail = { res: `threw ${errInfo(e)}` }; }
            }
          }
          c.pbAfterRecovery = await pbState(lib, fmt);
        } catch (e) { c.fatal = errInfo(e); }
        R.cases.push(c);
        globalThis.gc?.();
      }
    }
    // 開檔中被中止（第 k 個 read）：同一個 instance 能否直接重新開檔
    for (const k of [1, 2]) {
      progress?.(`${file} open k=${k}`);
      const c = { scenario: `open(read#${k})`, strategy: "reopen-same-instance" };
      try {
        const { lib, rd } = await setup(module, file, lat, chunk);
        let i = 0;
        rd.onPending = () => { if (++i === k) { rd.lat = STALL; setTimeout(() => rd.ac.abort(), 30); } };
        try { await open(lib); c.abortCall = `open resolved (reads=${i})`; } catch (e) { c.abortCall = `rejected ${errInfo(e)}`; }
        disarm(rd, lat);
        await STRATEGIES.dev(lib);
        const { fmt, pkt } = await open(lib);
        await readN(lib, fmt, pkt, warm);
        await seek(lib, fmt, target);
        const r = await readN(lib, fmt, pkt, n);
        c.result = { res: r.res, got: r.sigs.length, matchRef: cmp(r.sigs), of: n };
      } catch (e) { c.fatal = errInfo(e); }
      R.cases.push(c);
    }
    delete R.refAll; delete R.ref;
    await sleep(0);
  }
  return out;
}
