// Turns graph-raw.json into public/data/graph.json: top wallets, merged edges, CSR adjacency,
// recent flows for particles, pool labels, and the cemetery summary from the Ledger's nursery data.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const RAW = path.resolve(fs.existsSync("indexer/graph-raw.json") ? "indexer/graph-raw.json" : "public/data/graph-raw.json");
const OUT = path.resolve("public/data/graph.json");
const MAX_NODES = Number(process.env.MAX_NODES || 6000);
const MAX_EDGES = Number(process.env.MAX_EDGES || 40000);
const MAX_FLOWS = Number(process.env.MAX_FLOWS || 4000);
const SEC_PER_BLOCK = 0.1016;

// merge every raw crawl file (main crawl + token-specific crawls)
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || 6);
const BUCKET_DIR = "indexer/buckets";
fs.mkdirSync(BUCKET_DIR, { recursive: true });
let rawFiles = fs.readdirSync("indexer").filter((f) => /^graph-raw.*\.json$/.test(f)).map((f) => path.join("indexer", f));
rawFiles = rawFiles.concat(fs.readdirSync(BUCKET_DIR).filter((f) => f.endsWith(".json")).map((f) => path.join(BUCKET_DIR, f)));
if (!rawFiles.length) rawFiles.push(RAW);
// keep only files that still touch the window; drop buckets that fell out of it
const newestHead = Math.max(...rawFiles.map((f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")).head || 0; } catch { return 0; } }));
const cutoff = newestHead - WINDOW_HOURS * Math.round(3600 / SEC_PER_BLOCK);
rawFiles = rawFiles.filter((f) => {
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  const keep = (r.head || 0) >= cutoff;
  if (!keep && f.startsWith(BUCKET_DIR)) { fs.unlinkSync(f); console.log("dropped old bucket", f); }
  return keep;
});
const raw = { tokens: {}, nodes: {}, edges: {}, stats: { logs: 0 }, head: 0, low: Infinity };
for (const f of rawFiles) {
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  Object.assign(raw.tokens, r.tokens);
  for (const [a, n] of Object.entries(r.nodes)) { const t = raw.nodes[a] || (raw.nodes[a] = {}); for (const [s, v] of Object.entries(n)) { const x = t[s] || (t[s] = { in: 0, out: 0, n: 0 }); x.in += v.in; x.out += v.out; x.n += v.n; } }
  for (const [k, e] of Object.entries(r.edges)) { const x = raw.edges[k] || (raw.edges[k] = { n: 0, v: 0, b: 0 }); x.n += e.n; x.v += e.v; x.b = Math.max(x.b, e.b); }
  raw.stats.logs += r.stats.logs; raw.head = Math.max(raw.head, r.head || 0); raw.low = Math.min(raw.low, r.low ?? Infinity);
  console.log(`merged ${f}: ${r.stats.logs} logs, tokens ${Object.values(r.tokens).map((t) => t.sym).join("/")}`);
}
const ORDER = ["CASHCAT", "BUN", "USDG", "WETH", "GIGA", "PONS"];
const TOK = ORDER.filter((s) => Object.values(raw.tokens).some((t) => t.sym === s)); // order = colour index
const addrOf = Object.fromEntries(Object.entries(raw.tokens).map(([a, t]) => [t.sym, a]));
const decOf = Object.fromEntries(Object.values(raw.tokens).map((t) => [t.sym, t.dec ?? (t.sym === "USDG" ? 6 : 18)]));
raw.tokens = Object.fromEntries(TOK.map((s) => [addrOf[s], { sym: s, dec: decOf[s] }]));
const tokIndex = Object.fromEntries(TOK.map((s, i) => [s, i]));

const pools = fs.existsSync("indexer/pools.json") ? JSON.parse(fs.readFileSync("indexer/pools.json", "utf8")) : [];
const LABELS = {
  "0x0000000000000000000000000000000000000000": { name: "Mint / Burn", role: "system" },
  "0x8366a39cc670b4001a1121b8f6a443a643e40951": { name: "Uniswap v4 PoolManager", role: "pool" },
  "0x81bfec7030b2325b014acd9890cf3f36f9c22678": { name: "UGLY treasury", role: "wallet" },
};
for (const p of pools) if (p.addr.length === 42) LABELS[p.addr] = { name: `${p.label} ${p.dex} pool`, role: "pool" };

// per-token volume scale (95th percentile of per-wallet volume) so USDG's 6 decimals and meme supplies compare
const perTokVols = Object.fromEntries(TOK.map((s) => [s, []]));
for (const n of Object.values(raw.nodes)) for (const [s, v] of Object.entries(n)) perTokVols[s].push(v.in + v.out);
const scale = {};
for (const s of TOK) {
  const a = perTokVols[s].sort((x, y) => x - y);
  scale[s] = a.length ? Math.max(1e-9, a[Math.floor(a.length * 0.95)]) : 1;
}

// score wallets
const scored = [];
for (const [addr, n] of Object.entries(raw.nodes)) {
  let mass = 0, count = 0, best = 0, bestTok = 0;
  const vols = {};
  for (const [s, v] of Object.entries(n)) {
    const nv = Math.log1p((v.in + v.out) / scale[s]);
    vols[s] = v;
    mass += nv; count += v.n;
    const pref = (s === "USDG" || s === "WETH") ? 0.55 : 1.0; // quote coins only win when nothing else moves
    if (nv * pref > best) { best = nv * pref; bestTok = tokIndex[s]; }
  }
  mass = Math.log1p(count) * 0.35 + mass;
  scored.push({ addr, mass, count, tok: bestTok, vols });
}
scored.sort((a, b) => b.mass - a.mass);
// quota per coin so memecoin hoods are visible next to the USDG/WETH crowd
const QUOTA = Number(process.env.QUOTA || 1400);
const chosen = new Set();
for (const s of TOK) {
  const ranked = scored.filter((n) => n.vols[s]).sort((a, b) => Math.log1p((b.vols[s].in + b.vols[s].out) / scale[s]) + Math.log1p(b.vols[s].n) - Math.log1p((a.vols[s].in + a.vols[s].out) / scale[s]) - Math.log1p(a.vols[s].n));
  for (const n of ranked.slice(0, QUOTA)) chosen.add(n);
}
for (const n of scored) { if (chosen.size >= MAX_NODES) break; chosen.add(n); }
for (const n of scored) if (LABELS[n.addr]) chosen.add(n);
const keep = [...chosen].sort((a, b) => b.mass - a.mass);
const index = new Map(keep.map((n, i) => [n.addr, i]));

// merge edges (undirected) among kept nodes
const merged = new Map();
const flows = [];
for (const [k, e] of Object.entries(raw.edges)) {
  const [from, to, sym] = k.split(">");
  const a = index.get(from), b = index.get(to);
  if (a == null || b == null || a === b) continue;
  const key = a < b ? a * 1e6 + b : b * 1e6 + a;
  const m = merged.get(key) || { a: Math.min(a, b), b: Math.max(a, b), n: 0, w: 0, tok: new Map() };
  const nv = e.v / scale[sym];
  m.n += e.n; m.w += Math.log1p(nv) + e.n * 0.05;
  m.tok.set(sym, (m.tok.get(sym) || 0) + nv);
  merged.set(key, m);
  flows.push({ s: a, t: b, tok: tokIndex[sym], v: nv, n: e.n, b: e.b });
}
let edges = [...merged.values()].sort((x, y) => y.w - x.w).slice(0, MAX_EDGES);
const degree = new Float32Array(keep.length);
for (const e of edges) { degree[e.a]++; degree[e.b]++; }

// CSR adjacency
const adj = keep.map(() => []);
for (const e of edges) {
  const w = Math.min(1, e.w / 6);
  adj[e.a].push([e.b, w]); adj[e.b].push([e.a, w]);
}
const offsets = new Uint32Array(keep.length + 1);
const neighbors = [], weights = [];
keep.forEach((_, i) => { offsets[i] = neighbors.length; for (const [j, w] of adj[i]) { neighbors.push(j); weights.push(w); } });
offsets[keep.length] = neighbors.length;

// recent flows: newest first
flows.sort((x, y) => y.b - x.b);
const recent = flows.slice(0, MAX_FLOWS);

// roles
const nodes = keep.map((n, i) => {
  const lab = LABELS[n.addr];
  const role = lab?.role || (degree[i] > 150 ? "hub" : "wallet");
  return {
    a: n.addr, m: +n.mass.toFixed(3), c: n.count, t: n.tok, d: degree[i], r: role,
    l: lab?.name, v: Object.fromEntries(Object.entries(n.vols).map(([s, v]) => [s, [+v.in.toPrecision(4), +v.out.toPrecision(4), v.n]])),
  };
});

// cemetery from the Ledger's nursery data
let cemetery = null;
const nurseryPath = [process.env.NURSERY, path.join(os.homedir(), "Desktop/pond-street-ledger/data/nursery.json"), "indexer/external/nursery.json"].filter(Boolean).find((f) => fs.existsSync(f));
if (nurseryPath) {
  const n = JSON.parse(fs.readFileSync(nurseryPath, "utf8"));
  cemetery = {
    updated: n.updated, tokensBorn: n.tokensBorn, poolsOpened: n.poolsOpened, medianLife: n.medianLife,
    weeks: n.weeks, ages: n.ages, method: n.method,
  };
}

const head = raw.head, low = raw.low;
const now = Date.now();
const out = {
  chainId: 4663, tokens: TOK, tokenAddrs: Object.keys(raw.tokens), decimals: TOK.map((s) => decOf[s]), scales: TOK.map((s) => scale[s]),
  window: { headBlock: head, lowBlock: low, blocks: head - low, hours: +(((head - low) * SEC_PER_BLOCK) / 3600).toFixed(2), exported: new Date(now).toISOString() },
  totals: { transfers: raw.stats.logs, wallets: Object.keys(raw.nodes).length, edges: Object.keys(raw.edges).length },
  kept: { nodes: nodes.length, edges: edges.length, flows: recent.length },
  nodes,
  edges: edges.map((e) => [e.a, e.b, +e.w.toFixed(2), tokIndex[[...e.tok.entries()].sort((x, y) => y[1] - x[1])[0][0]]]),
  csr: { offsets: Array.from(offsets), neighbors, weights: weights.map((w) => +w.toFixed(3)) },
  flows: recent.map((f) => [f.s, f.t, f.tok, +Math.min(1, Math.log1p(f.v) / 4).toFixed(3), f.b]),
  cemetery,
};
fs.writeFileSync(OUT, JSON.stringify(out));

// ---- summary.json: the small, text-friendly digest the Ledger page renders server-side
const perTokTx = Object.fromEntries(TOK.map((s) => [s, 0]));
const perTokWallets = Object.fromEntries(TOK.map((s) => [s, 0]));
for (const n of Object.values(raw.nodes)) for (const [s, v] of Object.entries(n)) { perTokWallets[s]++; }
for (const [k, e] of Object.entries(raw.edges)) perTokTx[k.split(">")[2]] += e.n;
const hoods = TOK.map((s) => ({ coin: s, transfers: perTokTx[s], wallets: perTokWallets[s] })).sort((a, b) => b.transfers - a.transfers);
const movers = nodes.filter((n) => n.r === "wallet").slice(0, 10).map((n) => ({ addr: n.a, transfers: n.c, counterparties: n.d, coin: TOK[n.t] }));
const hubs = nodes.filter((n) => n.r !== "wallet").slice(0, 8).map((n) => ({ addr: n.a, label: n.l || null, role: n.r, transfers: n.c, counterparties: n.d }));
fs.writeFileSync(path.join(path.dirname(OUT), "summary.json"), JSON.stringify({
  chainId: 4663, window: out.window, totals: out.totals, kept: out.kept, tokens: TOK, hoods, movers, hubs,
  cemetery: cemetery ? { tokensBorn: cemetery.tokensBorn, updated: cemetery.updated, medianLife: cemetery.medianLife } : null,
}, null, 1));
console.log("summary.json:", hoods.map((h) => `${h.coin} ${h.transfers}`).join(", "));
console.log(`graph.json: ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB, nodes=${nodes.length} edges=${edges.length} flows=${recent.length} window=${out.window.hours}h transfers=${raw.stats.logs}`);
console.log("top hubs:", nodes.slice(0, 8).map((n) => `${n.l || n.a.slice(0, 8)}(${n.r},deg ${n.d})`).join(", "));
