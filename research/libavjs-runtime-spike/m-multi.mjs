// 拋棄式 spike（#17）：同一個 Worker 內多個 instance（主檔＋外掛音軌）的記憶體與 CPU；也比較「每個來源一個 Worker」。
import { spawnSvc, rss } from "./svc.mjs";

export async function run({ sec = 30 } = {}, log) {
  const out = { steps: [] };
  const step = async (label, extra) => { const r = await rss(label); out.steps.push({ ...r, ...extra }); log(`${label} ${JSON.stringify(r)} ${extra ? JSON.stringify(extra) : ""}`); };
  await step("baseline");
  const w = spawnSvc();
  await w.ready;
  await step("1 Worker，無 instance");
  await w.call("add", { file: "ab.mkv" });
  await step("+ 主檔 ab.mkv（H.264＋AAC）", { play: await w.call("play", { sec }) });
  await w.call("add", { file: "ext.mp3" });
  await step("+ 外掛音軌 ext.mp3（同一個 Worker）", { play: await w.call("play", { sec }) });
  await w.call("add", { file: "ext.mp3" });
  await w.call("add", { file: "ext.mp3" });
  await step("共 4 個 instance（同一個 Worker）", { play: await w.call("play", { sec }) });
  await w.call("drop");
  await step("close 全部、放掉參照（Worker 還在）", { gc: await w.call("gc") });
  w.terminate();
  await step("terminate Worker");

  // 對照：每個來源一個 Worker
  const ws = [spawnSvc(), spawnSvc()];
  await Promise.all(ws.map((x) => x.ready));
  await ws[0].call("add", { file: "ab.mkv" });
  await ws[1].call("add", { file: "ext.mp3" });
  const plays = await Promise.all(ws.map((x) => x.call("play", { sec })));
  await step("對照：主檔與外掛音軌各一個 Worker", { play: plays });
  ws.forEach((x) => x.terminate());
  await step("terminate 兩個 Worker");
  return out;
}
