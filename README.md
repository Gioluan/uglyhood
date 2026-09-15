# UGLYHOOD on ROBINHOOD

A live WebGPU map of who moves PONS, CASHCAT, Bundle Cat, GIGA, USDG and ETH on Robinhood Chain, wallet by wallet, plus the cemetery of coins that did not make it. Built with [vgpu](https://github.com/vercel-labs/vgpu).

- Live: https://robinhood-map.vercel.app
- `npm run crawl` reads ERC-20 Transfer logs from the public RPC into `indexer/` (env `HOURS`, `SINCE`, `ONLY`, `OUT`, `PACE_MS`).
- `npm run export` folds the raw buckets into `public/data/graph.json` and `summary.json`.
- `npm run dev` serves the page; the browser polls the chain itself for the live tail.
- `.github/workflows/hourly.yml` refreshes the six-hour window every hour and redeploys.

Skins: `?skin=ledger` for The Pond Street Ledger, `?embed=1` for the bare plate, `?coin=PONS` to open on one hood, `?a=0x…` to open on a wallet.
