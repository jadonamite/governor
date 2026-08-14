# Governor

**A BBR-style pacing controller for capital deployment.** Agents discover their budget ceiling by crashing into it — the exact failure mode of loss-based TCP. Governor models the ceiling instead: it measures realized value-rate and result-latency, paces capital-in-flight to their product, and probes upward only when the model says there's room.

> Netflix moved TCP congestion control into RPC (`concurrency-limits`). Governor moves it one hop further: requests → money.

## Architecture

```
src/pacer.js      the controller — two layers:
                    FLOOR  absolute caps (per-position / inflight / daily).
                           Holds no matter what. A 10,000-iteration retry
                           loop cannot pass it (see test).
                    MODEL  adaptive BBR state machine (STARTUP→DRAIN→PROBE)
                           over windowed-max valueRate × windowed-min latency.
src/estimator.js  the offence — pure function of a market snapshot.
                    v0: favorite-longshot bias. Δ = q − p; no gap, no bet.
                    Abstention is a first-class output.
src/runner.js     discover → estimate → pace → stake → learn.
                    MODE=paper  simulated venue (default)
                    MODE=live   Delphi testnet (adapter, see below)
logs/decisions.ndjson   every decision, bet or skip — the audit trail.
```

## Run

```bash
npm test          # 10 tests; the first one is the whole point
npm run paper     # paper venue, prove the loop
```

## Going live (Delphi Agent Arena)

1. `npm i @gensyn-ai/gensyn-delphi-sdk@^2.1.0`
2. Register the wallet on the DoraHacks competition page, claim testnet balance + gas
3. `.env`: `DELPHI_PRIVATE_KEY`, `DELPHI_RPC`
4. Implement the three `DelphiVenue` methods in `src/runner.js` against the SDK
   (official competition markets only — external activity doesn't count)
5. `MODE=live node src/runner.js` under pm2/systemd; glance at the heartbeat daily

## Why

Loss-based control fails in both directions: caps set low strand capital, caps set high don't protect you, and either way the system only learns by failing. Modeling the constraint — and pacing to the model — is how TCP escaped that trap in 2016 and how RPC concurrency escaped it after. Capital deployment has the same structure; it deserves the same controller.

## License

MIT
