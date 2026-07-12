<!-- Data through 2026-07-12 14:33 UTC+8 (restored from that day's pg_dump; the live DB
was temporarily orphaned onto a fresh volume during the credential rotation — see
EDR 0011 / the volume-pinning fix in docker-compose.yml). Regenerate against the
live record with: bun run record:report -->

# Forward-test record review — engine 1.0.0

Generated 2026-07-12T09:01:26.037Z · read-only (EDR 0011)

## Shadow record (44 opened, 37 settled)

| Cohort          | n   | Win rate [Wilson 95%] | Avg R ± SE    | Expired |
| --------------- | --- | --------------------- | ------------- | ------- |
| **All settled** | 37  | 27.0% [15.4%–43.0%]   | -0.24R ± 0.20 | 27.0%   |
| spot            | 37  | 27.0% [15.4%–43.0%]   | -0.24R ± 0.20 | 27.0%   |

> ⚠ 27.0% of settled calls expired (hit neither level within the intent horizon) — they dilute win-rate/expectancy readings; Phase 3's pre-registration must decide how to treat them.

## By setup × regime (shrinkage prior m=15 toward pooled 27.0%; report-only)

| Cell                                      | n   | Win rate [Wilson 95%] → shrunk       | Avg R ± SE    | Expired |
| ----------------------------------------- | --- | ------------------------------------ | ------------- | ------- |
| higher-low-continuation × high-volatility | 8   | 50.0% [21.5%–78.5%] → shrunk 35.0%   | +0.04R ± 0.24 | 87.5%   |
| failed-breakout × breakout-compression    | 4   | 25.0% [4.6%–69.9%] → shrunk 26.6%    | +0.00R ± 1.00 | 0.0%    |
| failed-breakout × high-volatility         | 4   | 0.0% [0.0%–49.0%] → shrunk 21.3%     | -1.00R ± 0.00 | 0.0%    |
| failed-breakout × mean-reversion          | 3   | 33.3% [6.1%–79.2%] → shrunk 28.1%    | -0.07R ± 0.93 | 0.0%    |
| higher-low-continuation × range-bound     | 3   | 33.3% [6.1%–79.2%] → shrunk 28.1%    | -0.07R ± 0.93 | 0.0%    |
| failed-breakout × range-bound             | 3   | 0.0% [0.0%–56.1%] → shrunk 22.5%     | -1.00R ± 0.00 | 0.0%    |
| pullback-continuation × trending-up       | 3   | 33.3% [6.1%–79.2%] → shrunk 28.1%    | +0.67R ± 1.20 | 33.3%   |
| higher-low-continuation × mean-reversion  | 3   | 33.3% [6.1%–79.2%] → shrunk 28.1%    | -0.07R ± 0.93 | 0.0%    |
| lower-high-rejection × trending-down      | 2   | 0.0% [0.0%–65.8%] → shrunk 23.8%     | -1.00R ± 0.00 | 0.0%    |
| pullback-continuation × range-bound       | 2   | 0.0% [0.0%–65.8%] → shrunk 23.8%     | -1.00R ± 0.00 | 0.0%    |
| pullback-continuation × mean-reversion    | 1   | 100.0% [20.7%–100.0%] → shrunk 31.6% | +1.20R        | 100.0%  |
| pullback-continuation × high-volatility   | 1   | 0.0% [0.0%–79.3%] → shrunk 25.3%     | -0.67R        | 100.0%  |

Demotion (the live rule) needs n ≥ 15 per cell with negative avg R; cells above that bar today: 0 of 12.

## Anticipatory fill model (graduation gate: 15 settled fills)

- opened 25 · decided 10 · filled 8 (fill rate 80.0%)
- settled fills 7/15 toward the gate · avg -0.19R ± 0.81

## Phase 3 gate (n ≥ 150 settled)

- 37 settled over 1.1 days (~33.8/day) → ~4 days to the gate at the observed rate (before the P2.1 universe expansion takes effect)

---

All versions in table: 0.9.0-dev, 1.0.0 · mis-stamped rows: 0
