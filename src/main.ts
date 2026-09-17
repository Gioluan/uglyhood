import { clock, compute, draw, effect, frameLoop, init, pingPongStorage, storage, surface } from "vgpu";
import simSrc from "./shaders/sim.wgsl";
import spawnSrc from "./shaders/spawn.wgsl";
import nodesSrc from "./shaders/nodes.wgsl";
import edgesSrc from "./shaders/edges.wgsl";
import flowSrc from "./shaders/flow.wgsl";
import bgSrc from "./shaders/bg.wgsl";
import gravesSrc from "./shaders/graves.wgsl";

type Node = { a: string; m: number; c: number; t: number; d: number; r: string; l?: string; v: Record<string, [number, number, number]>; live?: boolean };
type Graph = {
  tokens: string[]; tokenAddrs: string[]; decimals: number[]; scales: number[];
  window: { headBlock: number; lowBlock: number; blocks: number; hours: number; exported: string };
  totals: { transfers: number; wallets: number; edges: number };
  kept: { nodes: number; edges: number; flows: number };
  nodes: Node[]; edges: [number, number, number, number][];
  csr: { offsets: number[]; neighbors: number[]; weights: number[] };
  flows: [number, number, number, number, number][];
  cemetery: null | {
    updated: string; tokensBorn: number; poolsOpened: number; medianLife: { label: string; survivalPct: number };
    weeks: { week: string; born: number; alive: number; checked: number; survivalPct: number }[];
    ages: { label: string; born: number; survivalPct: number }[]; method: string;
  };
};
type FrameLike = Parameters<Parameters<typeof frameLoop>[1]>[0];

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const COLORS = ["#ffd166", "#ff5fa2", "#bfead0", "#5aa9ff", "#2ef2ff", "#ff5c1f"];
const NAMES: Record<string, string> = { CASHCAT: "CASHCAT", BUN: "BUNDLE CAT", USDG: "USDG", WETH: "ETH", GIGA: "GIGA", PONS: "PONS" };
const ROLE = { wallet: 0, pool: 1, hub: 2, system: 3 } as const;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n >= 100 ? n.toFixed(0) : n.toFixed(2);
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
let cemPass: ((f: FrameLike) => void) | null = null;

async function main() {
  if (!("gpu" in navigator)) { $("nogpu").hidden = false; $("stats").hidden = true; return; }
  const [gpu, graph] = await Promise.all([init(), fetch(import.meta.env.BASE_URL + "data/graph.json").then((r) => r.json() as Promise<Graph>)]);
  const canvas = $<HTMLCanvasElement>("map");
  const surf = surface(gpu, canvas, { dpr: [1, 2] });
  const T = graph.tokens.length;
  const tokByAddr = new Map(graph.tokenAddrs.map((a, i) => [a.toLowerCase(), i]));

  // ---------- capacities: snapshot + room for wallets and links that appear live ----------
  const n0 = graph.nodes.length, CAP = n0 + 4000;
  const E0 = graph.edges.length, ECAP = E0 + 8000;
  const FCAP = Math.max(graph.flows.length, 4000);
  let count = n0, ecount = E0;
  const R = Math.sqrt(n0) * 0.9;

  const posInit = new Float32Array(CAP * 4);
  const attr = new Float32Array(CAP * 4);
  const seedPositions = () => {
    for (let i = 0; i < count; i++) {
      const nd = graph.nodes[i];
      const th = Math.random() * Math.PI * 2;
      if (nd.r === "wallet") {
        const a = (nd.t / T) * Math.PI * 2 - Math.PI / 2;
        const rr = Math.random() * R * 0.45;
        posInit[i * 4] = Math.cos(a) * R * 0.55 + Math.cos(th) * rr; posInit[i * 4 + 1] = Math.sin(a) * R * 0.55 + Math.sin(th) * rr;
      } else {
        const rr = Math.random() * R * 0.3;
        posInit[i * 4] = Math.cos(th) * rr; posInit[i * 4 + 1] = Math.sin(th) * rr;
      }
      posInit[i * 4 + 2] = 0; posInit[i * 4 + 3] = 0;
    }
  };
  seedPositions();
  const setAttr = (i: number, nd: Node) => { attr[i * 4] = nd.m; attr[i * 4 + 1] = nd.t; attr[i * 4 + 2] = ROLE[nd.r as keyof typeof ROLE] ?? 0; attr[i * 4 + 3] = nd.d; };
  graph.nodes.forEach((nd, i) => setAttr(i, nd));

  const edgeData = new Float32Array(ECAP * 4);
  graph.edges.forEach((e, i) => { edgeData[i * 4] = e[0]; edgeData[i * 4 + 1] = e[1]; edgeData[i * 4 + 2] = e[2]; edgeData[i * 4 + 3] = e[3]; });
  const edgeKey = new Map<number, number>();
  const ek = (a: number, b: number) => (a < b ? a * 1e6 + b : b * 1e6 + a);
  graph.edges.forEach((e, i) => edgeKey.set(ek(e[0], e[1]), i));

  const flowData = new Float32Array(FCAP * 4);
  const flowBirth = new Float32Array(FCAP).fill(-1e6);
  graph.flows.forEach((f, i) => { flowData[i * 4] = f[0]; flowData[i * 4 + 1] = f[1]; flowData[i * 4 + 2] = f[2]; flowData[i * 4 + 3] = f[3]; });
  let fhead = graph.flows.length % FCAP;

  // CSR adjacency (rebuilt on the CPU when live links accumulate)
  const NCAP = ECAP * 2;
  const offsets = new Uint32Array(CAP + 1);
  const neighbors = new Uint32Array(NCAP);
  const weights = new Float32Array(NCAP);
  const buildCSR = () => {
    const adj: [number, number][][] = Array.from({ length: count }, () => []);
    for (let i = 0; i < ecount; i++) {
      const a = edgeData[i * 4], b = edgeData[i * 4 + 1], w = Math.min(1, edgeData[i * 4 + 2] / 6);
      adj[a].push([b, w]); adj[b].push([a, w]);
    }
    let k = 0;
    for (let i = 0; i < count; i++) { offsets[i] = k; for (const [j, w] of adj[i]) { if (k >= NCAP) break; neighbors[k] = j; weights[k] = w; k++; } }
    for (let i = count; i <= CAP; i++) offsets[i] = k;
  };
  buildCSR();

  // ---------- GPU resources ----------
  const pp = pingPongStorage(gpu, CAP * 16);
  pp.read.write(posInit);
  const attrBuf = storage(gpu, attr.byteLength, "read"); attrBuf.write(attr);
  const offBuf = storage(gpu, offsets.byteLength, "read"); offBuf.write(offsets);
  const nbrBuf = storage(gpu, neighbors.byteLength, "read"); nbrBuf.write(neighbors);
  const wBuf = storage(gpu, weights.byteLength, "read"); wBuf.write(weights);
  const edgeBuf = storage(gpu, edgeData.byteLength, "read"); edgeBuf.write(edgeData);
  const flowBuf = storage(gpu, flowData.byteLength, "read"); flowBuf.write(flowData);
  const birthBuf = storage(gpu, flowBirth.byteLength, "read"); birthBuf.write(flowBirth);
  const anchors = new Float32Array(16);
  graph.tokens.forEach((_, i) => { const th = (i / T) * Math.PI * 2 - Math.PI / 2; anchors[i * 2] = Math.cos(th) * R * 0.55; anchors[i * 2 + 1] = Math.sin(th) * R * 0.55; });
  const anchorBuf = storage(gpu, anchors.byteLength, "read"); anchorBuf.write(anchors);
  const SPAWN_MAX = 1024;
  const spawnList = new Float32Array(SPAWN_MAX * 4);
  let spawnCount = 0;
  const spawnBuf = storage(gpu, spawnList.byteLength, "read");

  const WG = 64;
  const simParams = { n: count, dt: 0.05, repulsion: 2.2, attraction: 0.06, gravity: 0.006, damping: 0.86, maxSpeed: 7.0, pad: 0 };
  const sim = compute(gpu, simSrc, { label: "layout", set: { params: simParams, src: pp.read, dst: pp.write, attr: attrBuf, offsets: offBuf, neighbors: nbrBuf, weights: wBuf, anchors: anchorBuf } });
  const spawn = compute(gpu, spawnSrc, { label: "spawn", set: { sp: { count: 0, pad0: 0, pad1: 0, pad2: 0 }, list: spawnBuf, state: pp.read } });

  const cam = { center: [0, 0] as [number, number], viewport: [1, 1] as [number, number], scale: 1, aspect: 1, time: 0, hover: -1, mask: (1 << T) - 1, zoomPx: 1, pad: [0, 0] as [number, number] };
  const scale0 = 2 / (R * 2.3);
  cam.scale = scale0;
  const bg = effect(gpu, bgSrc, { label: "bg", set: { bg: { viewport: cam.viewport, center: cam.center, scale: cam.scale, aspect: 1 } } });
  const edges = draw(gpu, { shader: edgesSrc, label: "edges", instances: ecount, vertices: 6, blend: "additive", set: { cam, pos: pp.read, edges: edgeBuf } });
  const flows = draw(gpu, { shader: flowSrc, label: "flows", instances: FCAP * 2, vertices: 6, blend: "additive", set: { cam, pos: pp.read, flows: flowBuf, births: birthBuf } });
  const nodes = draw(gpu, { shader: nodesSrc, label: "nodes", instances: count, vertices: 6, blend: "premultiplied", set: { cam, pos: pp.read, attr: attrBuf } });

  // ---------- UI: stats + legend ----------
  const stats = $("stats");
  stats.classList.add("ready");
  const exported = new Date(graph.window.exported);
  stats.innerHTML = `<div class="k">LAST ${graph.window.hours.toFixed(1)} HOURS ON CHAIN</div>
    <div class="row"><span>transfers</span><b>${graph.totals.transfers.toLocaleString("en")}</b></div>
    <div class="row"><span>addresses</span><b>${graph.totals.wallets.toLocaleString("en")}</b></div>
    <div class="row"><span>mapped</span><b id="st-mapped">${count.toLocaleString("en")}</b></div>
    <div class="row"><span>links</span><b id="st-links">${ecount.toLocaleString("en")}</b></div>
    <div class="row"><span>snapshot</span><b>${exported.toISOString().slice(11, 16)} UTC</b></div>
    <div class="row live"><span><i class="dot" id="live-dot"></i>live</span><b id="st-live">connecting…</b></div>`;
  const legend = $("legend");
  const perTok = graph.tokens.map((_, ti) => graph.nodes.reduce((s, nd) => s + (nd.t === ti ? 1 : 0), 0));
  legend.innerHTML = `<div class="k" style="width:100%">COINS · CLICK TO TOGGLE</div>` + graph.tokens.map((t, i) =>
    `<button class="chip" data-i="${i}" style="color:${COLORS[i]}"><i></i>${NAMES[t] || t}<small>${perTok[i]}</small></button>`).join("");
  legend.querySelectorAll<HTMLButtonElement>(".chip").forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.i); cam.mask ^= 1 << i; b.classList.toggle("off", !(cam.mask & (1 << i)));
  }));

  // ---------- camera + input ----------
  const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; cam.viewport = [w * surf.dpr, h * surf.dpr]; cam.aspect = w / h; };
  resize();
  surf.onResize(resize);
  const toWorld = (px: number, py: number): [number, number] => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const cx = (px / w) * 2 - 1, cy = 1 - (py / h) * 2;
    return [cam.center[0] + (cx * cam.aspect) / cam.scale, cam.center[1] + cy / cam.scale];
  };
  const toScreen = (x: number, y: number): [number, number] => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const cx = ((x - cam.center[0]) * cam.scale) / cam.aspect, cy = (y - cam.center[1]) * cam.scale;
    return [((cx + 1) / 2) * w, ((1 - cy) / 2) * h];
  };
  let userCam = false;
  const pointers = new Map<number, { x: number; y: number }>();
  let dragging = false, lastPinch = 0, moved = false;
  canvas.addEventListener("pointerdown", (e) => { userCam = true; pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); dragging = true; moved = false; canvas.classList.add("dragging"); });
  canvas.addEventListener("pointerup", (e) => { pointers.delete(e.pointerId); if (pointers.size === 0) { dragging = false; canvas.classList.remove("dragging"); if (!moved) togglePin(); } lastPinch = 0; });
  canvas.addEventListener("pointercancel", (e) => { pointers.delete(e.pointerId); dragging = pointers.size > 0; });
  canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (dragging && prev) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        cam.center[0] -= (dx / canvas.clientWidth) * 2 * cam.aspect / cam.scale;
        cam.center[1] += (dy / canvas.clientHeight) * 2 / cam.scale;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = canvas.getBoundingClientRect();
        if (lastPinch) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / lastPinch);
        lastPinch = d; moved = true;
      }
    } else {
      const r = canvas.getBoundingClientRect();
      hoverAt(e.clientX - r.left, e.clientY - r.top);
    }
  });
  canvas.addEventListener("pointerleave", () => { if (!pinned) setHover(-1); });
  const zoomAt = (px: number, py: number, factor: number) => {
    const before = toWorld(px, py);
    cam.scale = Math.min(Math.max(cam.scale * factor, scale0 * 0.35), scale0 * 60);
    const after = toWorld(px, py);
    cam.center[0] += before[0] - after[0]; cam.center[1] += before[1] - after[1];
    cam.zoomPx = Math.min(Math.max(Math.sqrt(cam.scale / scale0), 0.55), 3.2);
  };
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); userCam = true; const r = canvas.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
  const fit = () => {
    const rs: number[] = [];
    for (let i = 0; i < count; i++) rs.push(Math.hypot(cpuPos[i * 4], cpuPos[i * 4 + 1]));
    rs.sort((a, b) => a - b);
    const r = Math.max(rs[Math.floor(rs.length * 0.975)] || R, 1);
    cam.center = [0, 0]; cam.scale = 2 / (r * 2.05); cam.zoomPx = Math.min(Math.max(Math.sqrt(cam.scale / scale0), 0.55), 3.2);
  };
  $("fit").addEventListener("click", () => { fit(); userCam = false; });
  let warm = 0;
  $("shake").addEventListener("click", () => { seedPositions(); pp.read.write(posInit); pp.write.write(posInit); warm = 0; });
  let paused = false;
  $("pause").addEventListener("click", () => { paused = !paused; $("pause").textContent = paused ? "PLAY" : "PAUSE"; $("pause").classList.toggle("active", paused); });

  // ---------- hover, pin, labels ----------
  let cpuPos: Float32Array = posInit;
  let pinned = false;
  const hoverCard = $("hover");
  const setHover = (i: number) => {
    if (cam.hover === i) return;
    cam.hover = i;
    if (i < 0) { hoverCard.hidden = true; return; }
    const nd = graph.nodes[i];
    const rows = Object.entries(nd.v).sort((a, b) => b[1][2] - a[1][2]).map(([t, [inn, out, cnt]]) =>
      `<tr><td>${NAMES[t] || t}</td><td>in ${fmt(inn)} · out ${fmt(out)} · ${cnt} tx</td></tr>`).join("");
    hoverCard.innerHTML = `<div class="k">${nd.l ? nd.l.toUpperCase() : nd.r.toUpperCase()}${nd.live ? " · SEEN LIVE" : ""}</div>
      <div class="addr">${nd.a}</div>
      <div class="role">${nd.d} counterparties · ${nd.c} transfers · moves mostly <span style="color:${COLORS[nd.t]}">${NAMES[graph.tokens[nd.t]]}</span></div>
      <table>${rows}</table>
      <div class="pin">${pinned ? "pinned · click empty space to release" : "click to pin"} · <a href="https://robinhoodchain.blockscout.com/address/${nd.a}" target="_blank" rel="noopener">explorer</a></div>`;
    hoverCard.hidden = false;
  };
  const nodeRadius = (i: number) => (1.3 + Math.sqrt(Math.max(attr[i * 4], 0)) * 2.4) * cam.zoomPx;
  const nearest = (px: number, py: number) => {
    let best = -1, bd = 14 * 14;
    for (let i = 0; i < count; i++) {
      const [sx, sy] = toScreen(cpuPos[i * 4], cpuPos[i * 4 + 1]);
      const r = Math.max(7, nodeRadius(i));
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < r * r && d < bd) { bd = d; best = i; }
    }
    return best;
  };
  let lastHoverPx: [number, number] = [-1, -1];
  const hoverAt = (px: number, py: number) => { lastHoverPx = [px, py]; if (!pinned && !fly) setHover(nearest(px, py)); };
  const togglePin = () => {
    const i = nearest(lastHoverPx[0], lastHoverPx[1]);
    if (pinned) { pinned = false; setHover(-1); setHover(i); }
    else if (i >= 0) { pinned = true; cam.hover = -2; setHover(i); }
  };
  const labelIdx = graph.nodes.map((nd, i) => ({ i, s: nd.m + (nd.l ? 3 : 0) + (nd.r === "hub" ? 1 : 0) })).sort((a, b) => b.s - a.s).slice(0, 16).map((x) => x.i);
  const labelsEl = $("labels");
  labelsEl.innerHTML = labelIdx.map((i) => { const nd = graph.nodes[i]; return `<div class="label ${nd.r}" data-i="${i}">${nd.l ? nd.l : short(nd.a)}</div>`; }).join("");
  const labelEls: HTMLDivElement[] = [...labelsEl.querySelectorAll<HTMLDivElement>(".label")];
  const placeLabels = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const el of labelEls) {
      const i = Number(el.dataset.i);
      const [sx, sy] = toScreen(cpuPos[i * 4], cpuPos[i * 4 + 1]);
      const vis = sx > -40 && sx < w + 40 && sy > -20 && sy < h + 20;
      el.style.display = vis ? "block" : "none";
      if (vis) el.style.transform = `translate(${sx.toFixed(1)}px, ${(sy - nodeRadius(i) - 2).toFixed(1)}px) translate(-50%, -100%)`;
    }
  };
  let reading = false;
  const readBack = async () => {
    if (reading) return; reading = true;
    try { cpuPos = new Float32Array(await pp.read.read()); } catch { /* ignore */ }
    reading = false;
    if (!userCam && warm < 900) fit();
  };
  setInterval(readBack, 200);

  // ---------- live tail: poll the chain for new transfers of the tracked coins ----------
  const time = clock(gpu);
  const addrIndex = new Map<string, number>(graph.nodes.map((nd, i) => [nd.a, i]));
  let pausePoll = false;
  let liveTx = 0, liveBlock = 0, lastBlock = 0, interval = 5000, dirtyAttr = false, dirtyEdges = false, dirtyFlows = false, dirtyCSR = 0;
  const stLive = $("st-live"), dot = $("live-dot");
  const rpc = async (calls: { method: string; params: unknown[] }[]) => {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, ...c }))) });
    if (!res.ok) throw new Error("http " + res.status);
    const arr = await res.json();
    return (Array.isArray(arr) ? arr : [arr]).sort((a, b) => a.id - b.id);
  };
  const hexBlock = (b: number) => "0x" + b.toString(16);
  const pushFlow = (s: number, t: number, tok: number, strength: number, birth: number) => {
    flowData[fhead * 4] = s; flowData[fhead * 4 + 1] = t; flowData[fhead * 4 + 2] = tok; flowData[fhead * 4 + 3] = strength;
    flowBirth[fhead] = birth;
    fhead = (fhead + 1) % FCAP; dirtyFlows = true;
  };
  const SPARKS_PER_POLL = 600;
  const addNode = (addr: string, tok: number, near: number) => {
    if (count >= CAP || spawnCount >= SPAWN_MAX) return -1;
    const i = count++;
    const nd: Node = { a: addr, m: 0.25, c: 0, t: tok, d: 0, r: "wallet", v: {}, live: true };
    graph.nodes[i] = nd; addrIndex.set(addr, i); setAttr(i, nd);
    const th = Math.random() * Math.PI * 2, rr = 1.5 + Math.random() * 2;
    const x = cpuPos[near * 4] + Math.cos(th) * rr, y = cpuPos[near * 4 + 1] + Math.sin(th) * rr;
    spawnList[spawnCount * 4] = i; spawnList[spawnCount * 4 + 1] = x; spawnList[spawnCount * 4 + 2] = y; spawnCount++;
    if (cpuPos.length >= CAP * 4) { cpuPos[i * 4] = x; cpuPos[i * 4 + 1] = y; }
    dirtyAttr = true;
    return i;
  };
  const bump = (i: number, tok: number, v: number, dir: 0 | 1) => {
    const nd = graph.nodes[i];
    const sym = graph.tokens[tok];
    const rec = nd.v[sym] || (nd.v[sym] = [0, 0, 0]);
    rec[dir] += v; rec[2]++; nd.c++;
    nd.m += 0.04 + Math.log1p(v / graph.scales[tok]) * 0.08;
    attr[i * 4] = nd.m; dirtyAttr = true;
  };
  const link = (a: number, b: number, tok: number, w: number) => {
    const key = ek(a, b);
    const idx = edgeKey.get(key);
    if (idx != null) { edgeData[idx * 4 + 2] += w; dirtyEdges = true; return; }
    if (ecount >= ECAP) return;
    const i = ecount++;
    edgeData[i * 4] = a; edgeData[i * 4 + 1] = b; edgeData[i * 4 + 2] = 1 + w; edgeData[i * 4 + 3] = tok;
    edgeKey.set(key, i); graph.nodes[a].d++; graph.nodes[b].d++; attr[a * 4 + 3]++; attr[b * 4 + 3]++;
    dirtyEdges = true; dirtyAttr = true; dirtyCSR++;
  };
  const ingest = (log: { address: string; topics: string[]; data: string; blockNumber: string }, birth: number, spark: boolean) => {
    const tok = tokByAddr.get(log.address.toLowerCase());
    if (tok == null || log.topics.length < 3) return;
    const from = "0x" + log.topics[1].slice(26), to = "0x" + log.topics[2].slice(26);
    const v = Number(BigInt(log.data)) / 10 ** graph.decimals[tok];
    let a = addrIndex.get(from), b = addrIndex.get(to);
    if (a == null && b == null) return;               // strangers trading with strangers stay off the map
    if (a == null) a = addNode(from, tok, b!);
    if (b == null) b = addNode(to, tok, a!);
    if (a < 0 || b < 0 || a === b) return;
    bump(a, tok, v, 1); bump(b, tok, v, 0);
    const strength = Math.min(1, Math.log1p(v / graph.scales[tok]) / 4);
    link(a, b, tok, 0.25 + strength);
    if (spark) pushFlow(a, b, tok, Math.max(0.35, strength), birth);
    liveTx++;
  };
  const poll = async () => {
    if (pausePoll) { setTimeout(poll, 1500); return; }   // a wallet lookup has the line; the public RPC is one-at-a-time per visitor
    try {
      const [bn, lg] = lastBlock
        ? await rpc([{ method: "eth_blockNumber", params: [] }, { method: "eth_getLogs", params: [{ fromBlock: hexBlock(lastBlock + 1), toBlock: "latest", address: graph.tokenAddrs, topics: [TRANSFER] }] }])
        : await rpc([{ method: "eth_blockNumber", params: [] }]);
      if (bn.error) throw new Error(bn.error.message);
      const head = Number(bn.result);
      if (!lastBlock) { lastBlock = head - 30; liveBlock = head; }
      else if (lg?.error) {
        if (/exceeds limit/i.test(lg.error.message)) { lastBlock = head - 30; }
        throw new Error(lg.error.message);
      } else {
        const logs = lg.result as { address: string; topics: string[]; data: string; blockNumber: string }[];
        let maxB = head;
        const spread = Math.min(4, logs.length / 150);          // a catch-up batch trickles in over a few seconds
        const firstSpark = Math.max(0, logs.length - SPARKS_PER_POLL);
        logs.forEach((l, k) => { ingest(l, time.time + (k / Math.max(1, logs.length)) * spread, k >= firstSpark); maxB = Math.max(maxB, Number(l.blockNumber)); });
        lastBlock = maxB; liveBlock = head;
        if (logs.length) { dot.classList.remove("flash"); void dot.offsetWidth; dot.classList.add("flash"); }
      }
      interval = 5000;
      stLive.textContent = `block ${liveBlock.toLocaleString("en")} · +${liveTx.toLocaleString("en")} tx`;
    } catch (e) {
      console.warn("live poll:", String((e as Error)?.message || e));
      interval = Math.min(interval * 2, 30000);
      stLive.textContent = `retrying in ${Math.round(interval / 1000)}s`;
    }
    setTimeout(poll, interval);
  };
  poll();

  // ---------- find a wallet: fly to it, or pull it from the chain and drop it in ----------
  let fly: null | { t0: number; c0: [number, number]; c1: [number, number]; s0: number; s1: number } = null;
  const flyTo = (i: number) => {
    userCam = true;
    const s1 = Math.max(cam.scale, scale0 * 7);
    fly = { t0: performance.now(), c0: [cam.center[0], cam.center[1]], c1: [cpuPos[i * 4], cpuPos[i * 4 + 1]], s0: cam.scale, s1 };
  };
  const focus = (i: number) => {
    pinned = true; cam.hover = -2; setHover(i);
    if (!labelIdx.includes(i)) {
      labelIdx.push(i);
      const nd = graph.nodes[i];
      const el = document.createElement("div"); el.className = "label " + nd.r; el.dataset.i = String(i); el.textContent = nd.l || short(nd.a);
      labelsEl.appendChild(el); labelEls.push(el);
    }
    flyTo(i);
  };
  const findForm = $<HTMLFormElement>("find"), findInput = $<HTMLInputElement>("find-addr"), findMsg = $("find-msg");
  const say = (msg: string, cls = "") => { findMsg.textContent = msg; findMsg.className = "find-msg " + cls; };
  const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2);
  let finding = false;
  const find = async (raw: string) => {
    const addr = raw.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) { say("that is not an address. 0x plus 40 hex characters.", "err"); return; }
    const known = addrIndex.get(addr);
    if (known != null) { say(`on the map · ${graph.nodes[known].c.toLocaleString("en")} transfers in the window`, "ok"); focus(known); return; }
    if (finding) return; finding = true; pausePoll = true;
    say("not on the map yet · reading its last six hours from the chain…");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const patient = async <X,>(fn: () => Promise<X>): Promise<X> => {   // the RPC throttles bursts; wait it out instead of failing
      for (let attempt = 1; ; attempt++) {
        try { return await fn(); }
        catch (e) {
          const m = String((e as Error)?.message || e);
          if (attempt >= 4 || !/Failed to fetch|Too Many|http 429|http 5|NetworkError/i.test(m)) throw e;
          say(`the chain is throttling · retrying in ${attempt * 5} s…`); await sleep(attempt * 5000);
        }
      }
    };
    try {
      await sleep(1200);   // let the last poll clear
      const [bn] = await patient(() => rpc([{ method: "eth_blockNumber", params: [] }]));
      const head = Number(bn.result);
      const tryRange = async (blocks: number) => {
        const from = hexBlock(Math.max(0, head - blocks));
        const [asFrom, asTo] = await rpc([
          { method: "eth_getLogs", params: [{ fromBlock: from, toBlock: "latest", address: graph.tokenAddrs, topics: [TRANSFER, pad(addr)] }] },
          { method: "eth_getLogs", params: [{ fromBlock: from, toBlock: "latest", address: graph.tokenAddrs, topics: [TRANSFER, null, pad(addr)] }] },
        ]);
        if (asFrom.error || asTo.error) throw new Error((asFrom.error || asTo.error).message);
        return [...asFrom.result, ...asTo.result] as { address: string; topics: string[]; data: string; blockNumber: string }[];
      };
      let logs: Awaited<ReturnType<typeof tryRange>>;
      await sleep(1500);
      try { logs = await patient(() => tryRange(215000)); }
      catch (e) { if (/exceeds limit|deadline|timeout/i.test(String((e as Error).message))) { say("busy wallet · narrowing to the last hour…"); await sleep(3000); logs = await patient(() => tryRange(36000)); } else throw e; }
      logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
      if (!logs.length) { say("no moves of these six coins in the last six hours. try another address.", "err"); return; }
      // seat the wallet next to its first known counterparty, or in the middle if it only trades with strangers
      const first = logs.find((l) => addrIndex.has("0x" + l.topics[1].slice(26)) || addrIndex.has("0x" + l.topics[2].slice(26)));
      const nearAddr = first ? (addrIndex.has("0x" + first.topics[1].slice(26)) ? "0x" + first.topics[1].slice(26) : "0x" + first.topics[2].slice(26)) : null;
      const near = nearAddr != null ? addrIndex.get(nearAddr)! : 0;
      const tok = tokByAddr.get(logs[logs.length - 1].address.toLowerCase()) ?? 0;
      const me = addNode(addr, tok, near);
      if (me < 0) { say("the map is full for this session. reload and try again.", "err"); return; }
      const sparkFrom = Math.max(0, logs.length - 40);
      logs.forEach((l, k) => ingest(l, time.time + (k >= sparkFrom ? (k - sparkFrom) * 0.08 : -1e6), true));
      // hand the wallet's colour to whichever coin it moved most
      const nd = graph.nodes[me];
      const best = Object.entries(nd.v).sort((a, b) => b[1][2] - a[1][2])[0];
      if (best) { nd.t = graph.tokens.indexOf(best[0]); attr[me * 4 + 1] = nd.t; dirtyAttr = true; }
      say(`found · ${logs.length.toLocaleString("en")} transfers in the window · ${nd.d} counterparties`, "ok");
      $("st-mapped").textContent = count.toLocaleString("en");
      // give the spawn a frame to land before flying
      setTimeout(() => focus(me), 60);
      history.replaceState(null, "", "?a=" + addr);
    } catch (e) {
      say("the chain did not answer: " + String((e as Error)?.message || e).slice(0, 80), "err");
    } finally { finding = false; pausePoll = false; }
  };
  findForm.addEventListener("submit", (e) => { e.preventDefault(); find(findInput.value); });
  const q = new URLSearchParams(location.search);
  const qa = q.get("a");
  if (qa) { findInput.value = qa; setTimeout(() => find(qa), 1500); }
  const qc = (q.get("coin") || "").toUpperCase();
  const ci = graph.tokens.indexOf(qc === "ETH" ? "WETH" : qc);
  if (ci >= 0) {
    // one hood in focus: only that coin lit, camera parked over its anchor once the layout settles
    cam.mask = 1 << ci;
    legend.querySelectorAll<HTMLButtonElement>(".chip").forEach((b) => b.classList.toggle("off", Number(b.dataset.i) !== ci));
    setTimeout(() => {
      // frame the hood itself: centroid of that coin's wallets, zoomed so most of them fit
      let sx = 0, sy = 0, k = 0;
      for (let i = 0; i < count; i++) if (graph.nodes[i].t === ci && graph.nodes[i].r === "wallet") { sx += cpuPos[i * 4]; sy += cpuPos[i * 4 + 1]; k++; }
      if (!k) return;
      const cx = sx / k, cy = sy / k;
      const rs: number[] = [];
      for (let i = 0; i < count; i++) if (graph.nodes[i].t === ci) rs.push(Math.hypot(cpuPos[i * 4] - cx, cpuPos[i * 4 + 1] - cy));
      rs.sort((a, b) => a - b);
      const r = Math.max(rs[Math.floor(rs.length * 0.9)] || 1, 1);
      userCam = true;
      fly = { t0: performance.now(), c0: [cam.center[0], cam.center[1]], c1: [cx, cy], s0: cam.scale, s1: Math.min(2 / (r * 2.2), scale0 * 12) };
    }, 2600);
  }

  // ---------- frame loop ----------
  frameLoop(gpu, (frame) => {
    cam.time = time.time;
    if (fly) {
      const t = Math.min(1, (performance.now() - fly.t0) / 750);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      cam.center = [fly.c0[0] + (fly.c1[0] - fly.c0[0]) * e, fly.c0[1] + (fly.c1[1] - fly.c0[1]) * e];
      cam.scale = Math.exp(Math.log(fly.s0) + (Math.log(fly.s1) - Math.log(fly.s0)) * e);
      cam.zoomPx = Math.min(Math.max(Math.sqrt(cam.scale / scale0), 0.55), 3.2);
      if (t >= 1) fly = null;
    }
    if (spawnCount) {
      spawnBuf.write(spawnList);
      spawn.set({ sp: { count: spawnCount, pad0: 0, pad1: 0, pad2: 0 }, state: pp.read });
      spawn.dispatch(Math.ceil(spawnCount / WG));
      spawnCount = 0;
      $("st-mapped").textContent = count.toLocaleString("en");
    }
    if (dirtyAttr) { attrBuf.write(attr); dirtyAttr = false; }
    if (dirtyEdges) { edgeBuf.write(edgeData); dirtyEdges = false; $("st-links").textContent = ecount.toLocaleString("en"); }
    if (dirtyFlows) { flowBuf.write(flowData); birthBuf.write(flowBirth); dirtyFlows = false; }
    if (dirtyCSR >= 20 || (dirtyCSR && warm % 600 === 0)) { buildCSR(); offBuf.write(offsets); nbrBuf.write(neighbors); wBuf.write(weights); dirtyCSR = 0; }
    if (!paused) {
      const steps = warm < 120 ? 3 : 1;
      const heat = warm < 240 ? 1 + (240 - warm) / 120 : 1;
      sim.set({ params: { ...simParams, n: count, dt: 0.05 * heat, damping: warm < 240 ? 0.8 : 0.86 } });
      for (let s = 0; s < steps; s++) { sim.set({ src: pp.read, dst: pp.write }); sim.dispatch(Math.ceil(count / WG)); pp.swap(); }
      warm++;
    }
    const pos = pp.read;
    bg.set({ bg: { viewport: cam.viewport, center: cam.center, scale: cam.scale, aspect: cam.aspect } });
    edges.set({ cam, pos }); flows.set({ cam, pos }); nodes.set({ cam, pos });
    frame.pass({ target: surf, clear: [0.027, 0.035, 0.051, 1] }, (pass) => {
      pass.draw(bg);
      pass.draw(edges, { instances: ecount });
      pass.draw(flows);
      pass.draw(nodes, { instances: count });
    });
    if (cemPass) cemPass(frame);
    placeLabels();
  });

  cemPass = cemetery(gpu, graph);
}

function cemetery(gpu: Awaited<ReturnType<typeof init>>, graph: Graph): ((f: FrameLike) => void) | null {
  const c = graph.cemetery;
  const canvas = $<HTMLCanvasElement>("graves");
  if (!c) { $("cemetery").hidden = true; return null; }
  const PER_STONE = 500;
  const weeks = c.weeks;
  const surf = surface(gpu, canvas, { dpr: [1, 2] });
  const stonesData: number[] = [];
  const build = () => {
    stonesData.length = 0;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const colW = W / weeks.length, pitchX = 9, pitchY = 11, perRow = Math.max(1, Math.floor((colW - 8) / pitchX));
    weeks.forEach((wk, wi) => {
      const count = Math.max(1, Math.round(wk.born / PER_STONE));
      const alive = Math.round(count * wk.survivalPct / 100);
      const x0 = wi * colW + (colW - Math.min(count, perRow) * pitchX) / 2 + pitchX / 2;
      const y0 = H - 12;
      let seed = wi * 9973 + 7;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const aliveSet = new Set<number>();
      while (aliveSet.size < alive && aliveSet.size < count) aliveSet.add(Math.floor(rnd() * count));
      for (let k = 0; k < count; k++) {
        const r = Math.floor(k / perRow), col = k % perRow;
        const px = x0 + col * pitchX, py = y0 - r * pitchY;
        if (py < 8) break;
        stonesData.push((px / W) * 2 - 1, 1 - (py / H) * 2, aliveSet.has(k) ? 1 : 0, rnd());
      }
    });
  };
  build();
  let stoneBuf = storage(gpu, Math.max(stonesData.length, 4) * 4, "read");
  stoneBuf.write(new Float32Array(stonesData));
  const gp = () => ({ viewport: [canvas.clientWidth * surf.dpr, canvas.clientHeight * surf.dpr], hover: 0, pad: 0 });
  const graves = draw(gpu, { shader: gravesSrc, label: "graves", instances: stonesData.length / 4, vertices: 6, set: { gp: gp(), stones: stoneBuf } });
  surf.onResize(() => {
    build();
    stoneBuf = storage(gpu, Math.max(stonesData.length, 4) * 4, "read"); stoneBuf.write(new Float32Array(stonesData));
    graves.set({ stones: stoneBuf, gp: gp() });
  });
  const pass = (f: FrameLike) => {
    f.pass({ target: surf, clear: [0.02, 0.027, 0.04, 1] }, (p) => p.draw(graves, { instances: stonesData.length / 4 }));
  };

  $("cem-weeks").innerHTML = weeks.map((w) => `<div><b>${w.week.slice(5)}</b>${w.born.toLocaleString("en")} born<br><em>${w.survivalPct}% alive</em></div>`).join("");
  const dead = Math.round(c.tokensBorn * (1 - (c.weeks.reduce((s, w) => s + w.alive, 0) / Math.max(1, c.weeks.reduce((s, w) => s + w.checked, 0)))));
  $("cem-stats").innerHTML = [
    ["TOKENS BORN", c.tokensBorn.toLocaleString("en"), `since the chain opened, ${c.poolsOpened.toLocaleString("en")} pools`],
    ["RESTING HERE", dead.toLocaleString("en"), "no trade in the last 24 hours"],
    ["MEDIAN LIFE", c.medianLife.label, `${c.medianLife.survivalPct}% still trade at that age`],
    ["ONE STONE", PER_STONE + " coins", `snapshot ${c.updated.slice(0, 10)}`],
  ].map(([k, v, s]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");
  return pass;
}

main().catch((e) => {
  console.error(e);
  const msg = String(e?.message || e);
  if (/adapter|webgpu|navigator\.gpu/i.test(msg)) { $("nogpu").hidden = false; $("stats").hidden = true; $("legend").hidden = true; return; }
  $("stats").innerHTML = `<div class="k">SOMETHING BROKE</div><div>${msg}</div>`;
});
