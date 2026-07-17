import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { computeDealingRange, type DealingRange } from "./equilibrium";
import { detectFvgs, selectFvgs } from "./fvg";
import { generateMockCandles } from "./mock-candles";
import { detectOrderBlocks, selectOrderBlocks, type OrderBlock } from "./orderblocks";
import { selectPoi } from "./poi";
import { buildPoiMap, rankPois, type UnifiedPoi } from "./poi-map";
import { computeMarketStructure } from "./structure";
import type { Candle } from "./types";
import { computeBaseZones, type BaseZone } from "./zones";
import { DREIMANN_TRADES, labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

function zone(
  kind: "demand" | "supply",
  priceLow: number,
  priceHigh: number,
  freshness: BaseZone["freshness"] = "fresh",
  startTime = 1,
): BaseZone {
  return { kind, priceLow, priceHigh, startTime, endTime: startTime + 1, freshness };
}

function block(
  kind: "demand" | "supply",
  priceLow: number,
  priceHigh: number,
  time = 5,
): OrderBlock {
  return {
    kind,
    priceLow,
    priceHigh,
    time,
    displacementTime: time + 1,
    displacementAtr: 1.5,
    sweptSwing: false,
  };
}

/** A range whose equilibrium is the midpoint of [low, high] — swings are stubs. */
function rangeAt(low: number, high: number): DealingRange {
  const swing = (kind: "high" | "low", price: number) => ({
    kind,
    price,
    time: 1,
    label: null,
    event: null,
    equal: null,
  });
  return {
    low: swing("low", low),
    high: swing("high", high),
    anchor: "low",
    equilibrium: (low + high) / 2,
  };
}

const range = rangeAt(100, 200); // equilibrium 150

describe("buildPoiMap", () => {
  it("lists every source without merging — an OB inside its base zone stays two reads", () => {
    const pois = buildPoiMap(
      [zone("demand", 110, 130)],
      [block("demand", 115, 125)],
      [],
      [],
      range,
    );
    expect(pois).toHaveLength(2);
    expect(pois.map((p) => p.source).sort()).toEqual(["base-zone", "order-block"]);
    // Both discount-side: proximal edges 130 and 125 sit below equilibrium 150.
    expect(pois.every((p) => p.position === "discount")).toBe(true);
  });

  it("derives zone state by replay and maps FVG kind onto demand/supply", () => {
    const candles: Candle[] = [
      { time: 1, open: 99, high: 100, low: 98, close: 99.5, volume: 1 },
      { time: 2, open: 99.5, high: 106, low: 99, close: 105.5, volume: 1 },
      { time: 3, open: 105.5, high: 107, low: 104, close: 106, volume: 1 },
    ];
    const pois = buildPoiMap([zone("demand", 90, 95)], [], detectFvgs(candles), candles, null);
    const zonePoi = pois.find((p) => p.source === "base-zone")!;
    expect(zonePoi.state).toBe("fresh"); // never revisited in this window
    expect(zonePoi.position).toBeNull(); // no range → no position, never a veto
    const fvgPoi = pois.find((p) => p.source === "fvg")!;
    expect(fvgPoi).toMatchObject({ kind: "demand", priceLow: 100, priceHigh: 104, state: "fresh" });
  });

  it("retains terminal OBs flagged: traded-through reads invalidated, kept on the ledger", () => {
    const ob = block("demand", 100, 102, 5);
    const bar = (time: number, low: number, close: number): Candle => ({
      time,
      open: close,
      high: close + 1,
      low,
      close,
      volume: 1,
    });
    // Close below the OB low after formation → invalidated, still listed.
    const through = buildPoiMap([], [ob], [], [bar(7, 98, 99)], null);
    expect(through).toHaveLength(1);
    expect(through[0].state).toBe("invalidated");
    // One shallow retest after leaving → tested.
    const tested = buildPoiMap([], [ob], [], [bar(7, 105, 106), bar(8, 101.5, 103)], null);
    expect(tested[0]?.state).toBe("tested");
    // A deep single visit (past half the band) → mitigated.
    const mitigated = buildPoiMap([], [ob], [], [bar(7, 105, 106), bar(8, 100.4, 103)], null);
    expect(mitigated[0]?.state).toBe("mitigated");
    // Never revisited → fresh.
    const fresh = buildPoiMap([], [ob], [], [bar(7, 105, 106), bar(8, 106, 107)], null);
    expect(fresh[0]?.state).toBe("fresh");
  });

  it("mints the opposite-kind iFVG when a bar closes fully through a gap (G6)", () => {
    const candles: Candle[] = [
      { time: 1, open: 99, high: 100, low: 98, close: 99.5, volume: 1 },
      { time: 2, open: 99.5, high: 106, low: 99, close: 105.5, volume: 1 },
      { time: 3, open: 105.5, high: 107, low: 104, close: 106, volume: 1 },
      // Closes below gapLow (100): the bullish gap [100, 104] inverts.
      { time: 4, open: 106, high: 106.5, low: 98.5, close: 99, volume: 1 },
    ];
    const pois = buildPoiMap([], [], detectFvgs(candles), candles, null);
    const original = pois.find((p) => p.source === "fvg")!;
    expect(original.state).toBe("invalidated");
    const ifvg = pois.find((p) => p.source === "ifvg")!;
    expect(ifvg).toMatchObject({
      kind: "supply",
      priceLow: 100,
      priceHigh: 104,
      startTime: 4,
      state: "fresh",
    });
  });

  it("is chronological by formation start", () => {
    const pois = buildPoiMap(
      [zone("demand", 10, 11, "fresh", 20)],
      [block("supply", 50, 51, 5)],
      [],
      [],
      null,
    );
    expect(pois.map((p) => p.source)).toEqual(["order-block", "base-zone"]);
  });
});

describe("rankPois — selectPoi's exact ordering (EDR 0009)", () => {
  // The deriver sees no candles here, so re-apply the stubbed freshness.
  const toPoi = (z: BaseZone): UnifiedPoi => ({
    ...buildPoiMap([z], [], [], [], range)[0],
    state: z.freshness,
  });

  it("discount side first, fresh over tested, nearest proximal edge, for longs", () => {
    const premium = toPoi(zone("demand", 155, 160, "fresh"));
    const discount = toPoi(zone("demand", 110, 120, "fresh"));
    expect(rankPois([premium, discount], "long", 170, range)[0]).toBe(discount);

    const tested = toPoi(zone("demand", 130, 140, "tested"));
    const fresh = toPoi(zone("demand", 110, 120, "fresh"));
    expect(rankPois([tested, fresh], "long", 170, range)[0]).toBe(fresh);

    const near = toPoi(zone("demand", 125, 135, "fresh"));
    const far = toPoi(zone("demand", 105, 115, "fresh"));
    expect(rankPois([near, far], "long", 170, range)[0]).toBe(near);
  });

  it("filters to reachable entry-kind POIs and mirrors for shorts", () => {
    const above = toPoi(zone("demand", 172, 180, "fresh"));
    expect(rankPois([above], "long", 170, range)).toHaveLength(0);

    const discount = toPoi(zone("supply", 140, 145, "fresh"));
    const premium = toPoi(zone("supply", 180, 190, "fresh"));
    expect(rankPois([discount, premium], "short", 130, range)[0]).toBe(premium);
    expect(rankPois([toPoi(zone("demand", 180, 190))], "short", 130, range)).toHaveLength(0);
  });

  it("sinks terminal states below live POIs but keeps them listed", () => {
    const dead: UnifiedPoi = { ...toPoi(zone("demand", 125, 135)), state: "invalidated" };
    const live = toPoi(zone("demand", 105, 115, "tested"));
    const ranked = rankPois([dead, live], "long", 170, range);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toBe(live);
    expect(ranked[1]).toBe(dead);
  });

  it("parity: on base-zones-only input, rankPois[0] is selectPoi's pick — the cutover seam", () => {
    for (const name of DREIMANN_TRADES) {
      const fixture = loadDreimannFixture(name);
      const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
      const context = fixture.series["4h"]!.filter((c) => c.time <= entryTime);
      const zones = computeBaseZones(context);
      const structure = computeMarketStructure(computePivots(context));
      const rng = computeDealingRange(structure);
      const fromPrice = fixture.labels.entry.price;
      for (const direction of ["long", "short"] as const) {
        const expected = selectPoi(zones, direction, fromPrice, rng);
        const ranked = rankPois(
          buildPoiMap(zones, [], [], context, rng),
          direction,
          fromPrice,
          rng,
        );
        if (expected === null) {
          expect(ranked).toHaveLength(0);
        } else {
          expect(ranked[0]).toMatchObject({
            source: "base-zone",
            kind: expected.kind,
            priceLow: expected.priceLow,
            priceHigh: expected.priceHigh,
            startTime: expected.startTime,
          });
          // The deriver refines "tested" into tested|mitigated (rank-equal —
          // both non-fresh), so selection parity holds across the split.
          if (expected.freshness === "fresh") {
            expect(ranked[0].state).toBe("fresh");
          } else {
            expect(["tested", "mitigated"]).toContain(ranked[0].state);
          }
        }
      }
    }
  });

  it("is deterministic over full detector output on synthetic and fixture series", () => {
    const series = [
      generateMockCandles("BTC", "4H", 360),
      loadDreimannFixture("zec-sl").series["4h"]!,
    ];
    for (const candles of series) {
      const structure = computeMarketStructure(computePivots(candles));
      const rng = computeDealingRange(structure);
      const map = buildPoiMap(
        computeBaseZones(candles),
        selectOrderBlocks(detectOrderBlocks(candles)),
        selectFvgs(detectFvgs(candles)),
        candles,
        rng,
      );
      expect(
        buildPoiMap(
          computeBaseZones(candles),
          selectOrderBlocks(detectOrderBlocks(candles)),
          selectFvgs(detectFvgs(candles)),
          candles,
          rng,
        ),
      ).toEqual(map);
      const from = candles[candles.length - 1].close;
      expect(rankPois(map, "long", from, rng)).toEqual(rankPois(map, "long", from, rng));
    }
  });
});
