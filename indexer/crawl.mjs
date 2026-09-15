// Polite adaptive crawler for ERC-20 Transfer logs on Robinhood Chain (chainId 4663).
// Aggregates into nodes (wallets) and edges (from->to per token). Persists to data/graph-raw.json.
import fs from "node:fs";
import path from "node:path";

const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const OUT = path.resolve(process.env.OUT || "indexer/graph-raw.json");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKENS = {
  "0x020bfc650a365f8bb26819deaabf3e21291018b4": { sym: "CASHCAT", dec: 18 },
  "0x07ebb29a38fbcb41563817e5e19f2cec619c90d2": { sym: "BUN", dec: 18 },
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { sym: "USDG", dec: 6 },
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": { sym: "WETH", dec: 18 },
  "0x5baaec1b70864f01dbdb747358ff59f2e2ccf7d5": { sym: "GIGA", dec: 18 },
  "0x39dbed3a2bd333467115de45665cc57f813c4571": { sym: "PONS", dec: 18 },
};
// ONLY=PONS,GIGA crawls a subset into its own OUT file; export.mjs merges every indexer/graph-raw*.json
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const ACTIVE = ONLY.length ? Object.fromEntries(Object.entries(TOKENS).filter(([, t]) => ONLY.includes(t.sym))) : TOKENS;
const HOURS = Number(process.env.HOURS || 6);
const BLOCKS_PER_HOUR = Math.round(3600 / 0.101);
const PACE_MS = Number(process.env.PACE_MS || 1500);
let win = Number(process.env.WIN || 200);
const MAX_WIN = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("HTTP " + res.status + " " + text.slice(0, 80)); }
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// state
const state = fs.existsSync(OUT)
  ? JSON.parse(fs.readFileSync(OUT, "utf8"))
  : { chainId: 4663, tokens: ACTIVE, nodes: {}, edges: {}, ranges: [], stats: { logs: 0 } };
const nodes = state.nodes; // addr -> { [sym]: { in, out, n } }
const edges = state.edges; // "from>to>sym" -> { n, v }

function addr(topic) { return "0x" + topic.slice(26); }
function ingest(log) {
  const t = ACTIVE[log.address.toLowerCase()];
  if (!t || log.topics.length < 3) return;
  const from = addr(log.topics[1]), to = addr(log.topics[2]);
  const v = Number(BigInt(log.data)) / 10 ** t.dec;
  const k = from + ">" + to + ">" + t.sym;
  const e = edges[k] || (edges[k] = { n: 0, v: 0, b: 0 });
  e.n++; e.v += v; e.b = Math.max(e.b, Number(log.blockNumber));
  for (const [a, dir] of [[from, "out"], [to, "in"]]) {
    const n = nodes[a] || (nodes[a] = {});
    const s = n[t.sym] || (n[t.sym] = { in: 0, out: 0, n: 0 });
    s[dir] += v; s.n++;
  }
  state.stats.logs++;
}

function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, OUT);
}

async function main() {
  const head = Number(await rpc("eth_blockNumber", []));
  // SINCE=<block>: incremental bucket from that block to head (hourly job). Otherwise the last HOURS hours.
  const since = Number(process.env.SINCE || 0);
  const target = since > 0 ? Math.max(since, head - HOURS * BLOCKS_PER_HOUR) : head - HOURS * BLOCKS_PER_HOUR;
  if (since > 0 && target >= head) { console.log("nothing new since", since); return; }
  // crawl backwards from head (newest first) unless resuming
  let cursor = state.cursor ?? head;
  if (state.head == null) state.head = head;
  console.log(`head=${head} target=${target} cursor=${cursor} win=${win} logs=${state.stats.logs}`);
  let sinceSave = 0, ok = 0;
  while (cursor > target) {
    const from = Math.max(target, cursor - win + 1), to = cursor;
    const t0 = Date.now();
    try {
      const logs = await rpc("eth_getLogs", [{
        fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
        address: Object.keys(ACTIVE), topics: [TRANSFER],
      }]);
      for (const l of logs) ingest(l);
      cursor = from - 1; state.cursor = cursor; state.low = from;
      ok++; sinceSave += logs.length;
      if (ok % 10 === 0 && win < MAX_WIN && logs.length < 3000) win = Math.min(MAX_WIN, Math.round(win * 1.5));
      console.log(`${new Date().toISOString().slice(11, 19)} blk ${from}-${to} win=${win} logs=${logs.length} total=${state.stats.logs} nodes=${Object.keys(nodes).length} edges=${Object.keys(edges).length} ${Date.now() - t0}ms`);
      if (sinceSave > 20000 || ok % 25 === 0) { save(); sinceSave = 0; }
    } catch (e) {
      const m = String(e.message);
      if (/exceeds limit/i.test(m)) { win = Math.max(10, Math.floor(win / 2)); console.log("cap hit, win ->", win); continue; }
      if (/Too Many|429|HTTP 5|fetch failed|ECONN/i.test(m)) { console.log("backoff 20s:", m.slice(0, 60)); await sleep(20000); continue; }
      console.log("error:", m.slice(0, 120)); await sleep(5000);
    }
    await sleep(PACE_MS);
  }
  state.complete = true;   // only a bucket that reached its target may be trusted as a resume point
  save();
  console.log("done. logs=", state.stats.logs, "nodes=", Object.keys(nodes).length, "edges=", Object.keys(edges).length);
}
main().catch((e) => { console.error(e); save(); process.exit(1); });
