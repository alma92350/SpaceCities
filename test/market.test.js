import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, jumpCapital, jumpCost, JUMP_COST, loadFreighter, unloadFreighter, stepGalaxy } from "../engine/galaxy.js";
import { createMarket, sell, buy, unitPrice, updateMarket, TRADE_LOT, aiBarter, quoteSell } from "../engine/market.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip } from "../engine/colony.js";
import { SPENDABLE, UNITS, BUILDINGS, UPGRADES } from "../engine/entities.js";

test("createGalaxy hands every world its own price book", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  assert.ok(s.market && s.market.base && s.market.pressure, "the active world has a market");
  assert.ok(s.market.base.ore > 0, "ore has an equilibrium price");
});

test("a commodity is priced cheaper where it's abundant than where it's absent", () => {
  const rich = createMarket({ map: { nodes: [{ com: "ore", max: 400 }] } });        // ore is the whole supply
  const lean = createMarket({ map: { nodes: [{ com: "crystals", max: 400 }] } });    // no ore deposits at all
  assert.ok(rich.base.ore < lean.base.ore, "ore costs less on an ore-rich world");
});

test("selling banks credits, spends stock, and pushes the price down", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 500;
  const before = g.credits, price0 = unitPrice(s.market, "ore", "sell");
  const proceeds = sell(g, s, "ore", 100);
  assert.ok(proceeds > 0, "credits earned");
  assert.equal(g.credits, before + proceeds, "credits went up by the proceeds");
  assert.equal(Math.floor(s.players.player.resources.ore), 400, "stock went down");
  assert.ok(unitPrice(s.market, "ore", "sell") < price0, "dumping stock drops the price");
});

test("buying spends credits, adds stock, and pushes the price up", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  g.credits = 5000;
  const price0 = unitPrice(s.market, "ore", "buy");
  const before = Math.floor(s.players.player.resources.ore || 0);
  const cost = buy(g, s, "ore", 50);
  assert.ok(cost > 0, "credits spent");
  assert.equal(g.credits, 5000 - cost, "credits went down by the cost");
  assert.equal(Math.floor(s.players.player.resources.ore), before + 50, "stock went up");
  assert.ok(unitPrice(s.market, "ore", "buy") > price0, "buying pushes the price up");
});

test("a buy costs more than the matching sell (the market spread)", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  assert.ok(unitPrice(s.market, "ore", "buy") > unitPrice(s.market, "ore", "sell"), "buy > sell");
});

test("trade pressure recovers toward equilibrium over time", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 1000;
  sell(g, s, "ore", 300);                                 // crash the price
  const crashed = s.market.pressure.ore;
  assert.ok(crashed < 0, "price is depressed after a big sale");
  for (let i = 0; i < 300; i++) updateMarket(s, 0.1);     // 30s of recovery
  assert.ok(s.market.pressure.ore > crashed, "the price recovers");
  assert.ok(Math.abs(s.market.pressure.ore) < Math.abs(crashed) / 2, "it relaxes well back toward equilibrium");
});

test("you can only sell what you hold and only buy what you can afford", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 10;
  const proceeds = sell(g, s, "ore", 100);                // only 10 in stock
  assert.ok(proceeds > 0, "sold the little there was");
  assert.equal(Math.floor(s.players.player.resources.ore), 0, "stock emptied, never negative");
  g.credits = 1;
  assert.equal(buy(g, s, "ore", 100), 0, "buys nothing when you can't afford a single unit");
});

test("a jump spends its fuel cost in credits and is refused when you can't pay", () => {
  const g = createGalaxy({ seed: 9 });
  const s = activeState(g);
  for (const u of [...s.units.values()]) if (u.type === "colonyship") deployColonyShip(s, u.id);   // deploy start ships → CCs
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);
  s.buildings.set(sp.id, sp);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y); s.units.set(ship.id, ship);   // vessel on the pad
  const dest = g.worlds.find(w => w !== g.activeId);
  const cost = jumpCost(g, dest);        // distance-scaled fuel to reach a new world
  assert.ok(cost > 0, "a new world costs fuel");

  g.credits = cost - 1;
  assert.equal(jumpCapital(g, dest), null, "a jump you can't fund is refused");
  assert.equal(g.activeId, s.planetId, "and you stay put");

  g.credits = cost + 250;
  const res = jumpCapital(g, dest);
  assert.ok(res, "a funded jump runs");
  assert.equal(g.credits, 250, "the fuel cost came out of credits");
});

test("TRADE_LOT is a sane positive lot size", () => {
  assert.ok(Number.isInteger(TRADE_LOT) && TRADE_LOT > 0);
});

// ---- battlefield debris is not a deposit -------------------------------------
// createMarket runs exactly twice per world: at creation (no debris exists yet) and on load
// (engine/persist.js, AFTER the saved wreck/crater nodes are back). If it counted those, the
// two runs would see different node sets, and since the abundance share is a fraction of the
// TOTAL, every raw commodity's price would move — not just the debris's own. So a played-in
// world came back from a save quoting a different price book than it was played on.

test("wreck and crater nodes never move a world's price book — they aren't what the world deposits", () => {
  const nodes = [{ com: "ore", max: 600 }, { com: "crystals", max: 400 }, { com: "radioactives", max: 300 }];
  const clean = createMarket({ planetId: "helix", map: { nodes } });
  const fought = createMarket({ planetId: "helix", map: { nodes: [...nodes,
    { com: "metals", max: 220, wreck: true },        // battle wreckage (engine/wreckage.js)
    { com: "ore", max: 180, crater: true },          // a Helium Bomb crater (engine/bomb.js)
  ] } });
  assert.deepEqual(fought.base, clean.base,
    "a world fought over prices identically to the same world untouched — for EVERY commodity, not just the debris's own");
});

test("a battle-scarred world round-trips its price book through a save", async () => {
  const { serializeGalaxy, deserializeGalaxy } = await import("../engine/persist.js");
  const g = createGalaxy({ seed: 91 });
  const s = activeState(g);
  const before = { ...s.market.base };
  // What a long war actually leaves: a wreck field of many small sites (engine/wreckage.js
  // returns WRECK_RETURN_FRAC of each dead thing's cost) plus a few Helium Bomb craters
  // (CRATER_NODE_AMOUNT, 400 each). It's the ACCUMULATION that moves prices, not one site.
  for (let i = 0; i < 20; i++)
    s.map.nodes.push({ id: `wreck-u${i}-metals`, com: "metals", amount: 120, max: 120, x: 500 + i, y: 500, wreck: true });
  for (let i = 0; i < 10; i++)
    s.map.nodes.push({ id: `wreck-u${i}-electronics`, com: "electronics", amount: 40, max: 40, x: 520 + i, y: 505, wreck: true });
  for (let i = 0; i < 3; i++)
    s.map.nodes.push({ id: `crater-b${i}`, com: "ore", amount: 400, max: 400, x: 700 + i * 30, y: 300, crater: true });

  // Fixture check: this much debris is genuinely enough to move the book, so the assertion
  // below can't pass merely because the drift rounded away.
  const naive = createMarket({ planetId: s.planetId, map: { nodes: s.map.nodes.map(n => ({ com: n.com, max: n.max })) } });
  assert.notDeepEqual(naive.base, before, "fixture: counting the debris WOULD price this world differently");

  const g2 = deserializeGalaxy(serializeGalaxy(g));
  const s2 = g2.planets.get(s.planetId);
  assert.equal(s2.map.nodes.filter(n => n.wreck || n.crater).length, 33, "sanity: the debris itself round-tripped");
  assert.deepEqual(s2.market.base, before, "…and the price book came back exactly as it was played on");
});

test("finished goods are dearer on a low-industry world than a high-industry one", () => {
  const forge = createMarket({ planetId: "forge", map: { nodes: [] } });   // industry 10 — floods its own market
  const oort = createMarket({ planetId: "oort", map: { nodes: [] } });      // industry 2 — can't make them
  assert.ok(oort.base.alloys > forge.base.alloys, "a frontier world pays more for the alloys it can't make");
  assert.ok(oort.base.machinery > forge.base.machinery, "…and for machinery");
});

test("a produced good at an industry-5 world matches the old flat 1.5× ceiling (continuity)", () => {
  const m = createMarket({ planetId: "vesper", map: { nodes: [] } });   // industry 5 pivot
  assert.equal(m.base.alloys, 120, "alloys base 80 × 1.5 = 120 — continuous with the pre-Phase-4 flat price");
});

// ---- Promote the legacy consumer-goods recipes into a trade-industry branch (docs/improvement-
// proposals.md lines 443-451): market.js already prices and gluts the WHOLE catalog (PRODUCED
// covers every non-Raw commodity, including 'chemicals' and 'goods') — these confirm that claim
// empirically for the new branch's actual output, rather than just trusting the generic rule.

test("Consumer Goods from the new trade-industry branch sell for real credits at the world's live per-world price, and dumping them gluts it like any other produced good", () => {
  const g = createGalaxy({ seed: 3 });
  const s = activeState(g);
  s.players.player.resources.goods = 100;
  const price0 = unitPrice(s.market, "goods", "sell");
  assert.ok(price0 > 0, "Consumer Goods carry a real, live per-world sell price (base 130, industry-scaled — market.js PRODUCED)");

  const before = g.credits;
  const proceeds = sell(g, s, "goods", 50);

  assert.ok(proceeds > 0, "goods sell for real credits, not a dead-end good");
  assert.equal(g.credits, before + proceeds, "credits banked the sale");
  assert.equal(Math.floor(s.players.player.resources.goods), 50, "stock went down by what was sold");
  assert.ok(unitPrice(s.market, "goods", "sell") < price0, "dumping goods on this world nudges its price down — the same glut treatment every other produced good gets");
});

test("Chemicals (the new branch's first hop) are tradeable and priced too, not just the finished goods at the end of it", () => {
  const g = createGalaxy({ seed: 3 });
  const s = activeState(g);
  s.players.player.resources.chemicals = 40;
  const proceeds = sell(g, s, "chemicals", 25);
  assert.ok(proceeds > 0, "chemicals — the Chemical Plant's own output — already sell for real credits, even before reaching the Fabricator");
});

test("goods sell dearer on a low-industry agri world like Verdani than on a high-industry one like Forge — the branch's designed niche", () => {
  // engine/aiArchetypes.js: "Verdani the low-industry agri contrast where finished goods sell dear" —
  // the whole point of promoting this branch is to give a biomass/spice world an industrial identity
  // whose payoff is exactly this price gap.
  const forge = createMarket({ planetId: "forge", map: { nodes: [] } });     // industry 10 — floods its own market
  const verdani = createMarket({ planetId: "verdani", map: { nodes: [] } }); // industry 3 — can't make them itself
  assert.ok(verdani.base.goods > forge.base.goods, "a low-industry agri world pays more for the consumer goods it can't make");
});

test("end-to-end: idle workers run the whole chem→consumer chain, and the resulting goods sell for real credits", () => {
  const g = createGalaxy({ seed: 3 });
  const s = activeState(g);
  for (const u of [...s.units.values()]) if (u.type === "colonyship") deployColonyShip(s, u.id);
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  s.players.player.upgrades.chemistry = true;
  s.players.player.upgrades.metallurgy = true;
  s.players.player.upgrades.consumerfab = true;
  // Plant the whole branch, completed, next to the capital — biomass and alloys ready in the
  // treasury so this is about the chem->consumer->market loop, not the ore->metals->alloys chain
  // (that's industry.test.js's own end-to-end coverage).
  for (const [type, dx] of [["reactor", 40], ["chemplant", 74], ["fabricator", 108]]) {
    const b = makeBuilding(type, "player", cc.x + dx, cc.y + 40);
    if (type === "reactor") b.input = { radioactives: 100000 };
    s.buildings.set(b.id, b);
  }
  s.players.player.resources.biomass = 5000;
  s.players.player.resources.alloys = 5000;
  for (let i = 0; i < 8; i++) { const w = makeUnit("worker", "player", cc.x + 20, cc.y + 20); s.units.set(w.id, w); }

  for (let i = 0; i < 5000 && (s.players.player.resources.goods || 0) < 5; i++) stepGalaxy(g, 0.1);

  assert.ok((s.players.player.resources.goods || 0) > 0, "workers fed the WHOLE new branch and hauled Consumer Goods back to the treasury");
  const creditsBefore = g.credits;
  const proceeds = sell(g, s, "goods", 1);
  assert.ok(proceeds > 0, "the credits engine actually pays out — goods sell for real money");
  assert.equal(g.credits, creditsBefore + proceeds, "credits banked the sale");
});

// ---- exact-value pins on the tuning constants themselves --------------------------------------
// Every test above only bounds or relative-asserts (buy > sell, price fell, cost > 0): real
// coverage, but a substantial drift in one of the constants market.js's pricing math is built on
// (say SPREAD 1.15 → 1.35) would still pass every one of them. These pin a real buy/sell output
// against the constant's CURRENT documented value, computed from the real formula (not a guessed
// number), so a drift in the constant itself — not just a directional regression — fails a test.

test("SPREAD is pinned exactly: buying one lot (TRADE_LOT) of a produced good, on a fresh market, costs base × 1.15 × TRADE_LOT", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  g.credits = 1000000;
  const base = s.market.base.machinery;                        // read off the REAL market, not guessed
  const expected = Math.round(base * 1.15 * TRADE_LOT);        // the exact buy() formula, one lot, zero pressure/glut
  assert.equal(buy(g, s, "machinery", TRADE_LOT), expected,
    "a drift in the buy-side SPREAD constant would pass every existing relative test but fails this exact pin");
});

test("RAW_SPREAD is pinned exactly: buying one lot of a raw good, on a fresh market, costs base × 1.5 × TRADE_LOT", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  g.credits = 1000000;
  const base = s.market.base.ore;
  const expected = Math.round(base * 1.5 * TRADE_LOT);
  assert.equal(buy(g, s, "ore", TRADE_LOT), expected,
    "a drift in RAW_SPREAD (the wide raw-input buy spread that closes the credit-printer loop) fails this exact pin");
});

// ---- Allied trade discount (Gifts and favor requests: an actual road to Allied) ----------------
// Once a world's neighbour reaches Allied (engine/diplomacy.js stanceLabel's own >= 0.6 band),
// buy() tightens its spread toward ALLIED_SPREAD (1.05) — friendship as a market yield, not just a
// peaceful border. unitPrice's existing 3-arg call stays byte-identical (the two SPREAD/RAW_SPREAD
// pins above already prove that with no diplomacy on the fixture at all) — the discount only
// applies when a 4th `state` argument carrying diplomacy is threaded through, which only buy()
// (and the HUD's own buy-price preview) does.

test("short of Allied, buy() still charges the ordinary SPREAD exactly", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  g.credits = 1000000;
  s.diplomacy.stance = 0.59;   // Cordial — just short of Allied (stanceLabel's own 0.6 line)
  const base = s.market.base.machinery;
  const expected = Math.round(base * 1.15 * TRADE_LOT);
  assert.equal(buy(g, s, "machinery", TRADE_LOT), expected, "short of Allied, buy() must charge the ordinary spread");
});

test("exactly AT the Allied threshold (stance 0.6), the spread is still the ordinary one — the discount ramps FROM here, not before", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  g.credits = 1000000;
  s.diplomacy.stance = 0.6;
  const base = s.market.base.machinery;
  const expected = Math.round(base * 1.15 * TRADE_LOT);
  assert.equal(buy(g, s, "machinery", TRADE_LOT), expected, "at the threshold itself, t=0 ⇒ unchanged spread");
});

test("a fully Allied world buys at exactly the tightened ALLIED_SPREAD (1.05), not the ordinary SPREAD", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  g.credits = 1000000;
  s.diplomacy.stance = 1.0;   // fully allied
  const base = s.market.base.machinery;
  const expected = Math.round(base * 1.05 * TRADE_LOT);
  assert.equal(buy(g, s, "machinery", TRADE_LOT), expected,
    "fully Allied ⇒ exactly ALLIED_SPREAD — a drift in the constant fails this pin");
});

test("the Allied discount ramps continuously between the threshold and full alliance, not a cliff", () => {
  const g1 = createGalaxy({ seed: 7 });
  const s1 = activeState(g1);
  g1.credits = 1000000;
  s1.diplomacy.stance = 0.8;   // halfway from Allied threshold (0.6) to fully allied (1.0)

  const g2 = createGalaxy({ seed: 7 });
  const s2 = activeState(g2);
  g2.credits = 1000000;
  s2.diplomacy.stance = 1.0;

  const atHalf = buy(g1, s1, "machinery", TRADE_LOT);
  const atFull = buy(g2, s2, "machinery", TRADE_LOT);
  const ordinary = Math.round(s1.market.base.machinery * 1.15 * TRADE_LOT);
  assert.ok(atFull < atHalf && atHalf < ordinary, "deeper into Allied buys cheaper still, not a flat step");
});

test("unitPrice's bare 3-arg buy-side call ignores diplomacy entirely, even on an Allied world's own market object", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.diplomacy.stance = 1.0;
  // Every pre-existing call site (aiBarter, the exact-value pins above) uses this 3-arg form and
  // must keep seeing the ordinary spread — the Allied discount only ever applies via the optional
  // 4th `state` argument, which only buy() (and the HUD's own preview) passes.
  assert.equal(unitPrice(s.market, "machinery", "buy"), s.market.base.machinery * 1.15);
});

test("PRESSURE_FLOOR is pinned exactly: heavy selling bottoms a raw good's price at 40% of equilibrium, not some other clamp", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 1e6;
  sell(g, s, "ore", 5000);                                     // far more than the ~300 units needed to saturate the floor
  assert.equal(s.market.pressure.ore, -0.6, "pressure bottoms out at exactly PRESSURE_FLOOR");
  // ore is Raw, so glut never applies to it — this isolates the pressure clamp alone.
  assert.equal(unitPrice(s.market, "ore", "sell"), s.market.base.ore * (1 + (-0.6)),
    "…so the sell price bottoms at exactly base × (1 + PRESSURE_FLOOR)");
});

test("PRESSURE_CEIL is pinned exactly: heavy buying tops a raw good's price at 160% of equilibrium, not some other clamp", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  g.credits = 1e9;
  buy(g, s, "ore", 5000);                                      // far more than the ~300 units needed to saturate the ceiling
  assert.equal(s.market.pressure.ore, 0.6, "pressure tops out at exactly PRESSURE_CEIL");
  // Read back via the SELL side (no spread) so this pins the pressure ceiling alone, not SPREAD too.
  assert.equal(unitPrice(s.market, "ore", "sell"), s.market.base.ore * (1 + 0.6),
    "…so the (spread-free) price tops at exactly base × (1 + PRESSURE_CEIL)");
});

test("GLUT_CEIL is pinned exactly: dumping a produced good saturates its glut at 0.85, not some other clamp", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.machinery = 1e6;
  sell(g, s, "machinery", 50000);                              // far more than needed to saturate both pressure and glut
  assert.equal(s.market.pressure.machinery, -0.6, "pressure also bottoms at PRESSURE_FLOOR from the same selling");
  assert.equal(s.market.glut.machinery, 0.85, "glut saturates at exactly GLUT_CEIL");
  const expected = s.market.base.machinery * (1 + (-0.6)) * (1 - 0.85);   // base × (1+PRESSURE_FLOOR) × (1-GLUT_CEIL)
  assert.equal(unitPrice(s.market, "machinery", "sell"), expected,
    "a fully-glutted, fully-pressured sell price lands exactly here — a drift in GLUT_CEIL fails this pin");
});

// ---- quoteSell: a pure dry-run preview for the bulk-trade UI (Sell x4 / Sell All) --------------
// hudSelection.js's tooltip previews what a bulk sell will actually pay by calling this instead of
// re-deriving the lot-walk math itself — these tests pin that the preview can never drift from the
// real sale, per the proposal's own "so a UI preview can never drift from engine math".

test("quoteSell previews exactly what sell() will actually pay, and never mutates the market", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 1000;
  const pressureBefore = s.market.pressure.ore || 0;

  const preview = quoteSell(s.market, "ore", 100);   // 4 lots
  assert.equal(s.market.pressure.ore || 0, pressureBefore, "a dry run must not move the real market's pressure");

  const proceeds = sell(g, s, "ore", 100);
  assert.equal(preview, proceeds, "the preview must match what the real sale actually pays, to the credit");
});

test("quoteSell reflects marginal pricing across multiple lots — 4 lots earn less than 4x the first lot's price", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  const oneLot = quoteSell(s.market, "ore", TRADE_LOT);
  const fourLots = quoteSell(s.market, "ore", TRADE_LOT * 4);
  assert.ok(fourLots > 0 && fourLots < oneLot * 4,
    "each successive lot sells at a lower marginal price (the same walk sell() itself does)");
});

test("quoteSell returns 0 for a zero or negative quantity, and touches nothing", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  const before = { ...s.market.pressure };
  assert.equal(quoteSell(s.market, "ore", 0), 0);
  assert.equal(quoteSell(s.market, "ore", -50), 0);
  assert.deepEqual(s.market.pressure, before, "no mutation from a no-op preview");
});

// ---- zero/negative quantity guards -------------------------------------------------------------

test("sell/buy reject a zero or negative quantity outright — no proceeds, no cost, no resource mutated", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 500;
  g.credits = 5000;
  const oreBefore = s.players.player.resources.ore, creditsBefore = g.credits;

  assert.equal(sell(g, s, "ore", 0), 0, "selling zero earns nothing");
  assert.equal(sell(g, s, "ore", -10), 0, "selling a negative quantity earns nothing");
  assert.equal(buy(g, s, "ore", 0), 0, "buying zero costs nothing");
  assert.equal(buy(g, s, "ore", -10), 0, "buying a negative quantity costs nothing");

  assert.equal(s.players.player.resources.ore, oreBefore, "stock is untouched by every zero/negative call above");
  assert.equal(g.credits, creditsBefore, "credits are untouched by every zero/negative call above");
});

test("loadFreighter/unloadFreighter reject a zero or negative quantity outright — neither the hold nor the stockpile moves", () => {
  const s = createGameState({ planetId: "ferros" });
  const f = makeUnit("hauler", "player", 0, 0);   // a real freighter: has .freight and a cargoHold
  s.units.set(f.id, f);
  s.players.player.resources.alloys = 100;
  f.freight.alloys = 40;

  assert.equal(loadFreighter(s, f.id, "alloys", 0), 0, "loading zero moves nothing");
  assert.equal(loadFreighter(s, f.id, "alloys", -5), 0, "loading a negative quantity moves nothing");
  assert.equal(unloadFreighter(s, f.id, "alloys", 0), 0, "unloading zero moves nothing");
  assert.equal(unloadFreighter(s, f.id, "alloys", -5), 0, "unloading a negative quantity moves nothing");

  assert.equal(s.players.player.resources.alloys, 100, "the stockpile is untouched by every zero/negative call above");
  assert.equal(f.freight.alloys, 40, "the hold is untouched by every zero/negative call above");
});

/* ---------- aiBarter (Tier 3 of the section-08 economic-dial proposal) ---------- */

// The largest amount any single unit/building/upgrade costs of `com` — the same "one big
// purchase" yardstick aiBarter itself measures surplus/bottleneck against (market.js's private
// MAX_SINGLE_COST), recomputed here so the test can set a baseline that's provably safe per
// commodity instead of guessing one flat number (a cheap-only commodity like AI Cores needs a
// much smaller "not surplus yet" baseline than ore does).
function maxSingleCostFor(com) {
  let max = 0;
  for (const d of [...Object.values(UNITS), ...Object.values(BUILDINGS), ...Object.values(UPGRADES)])
    max = Math.max(max, d.cost?.[com] || 0);
  return max;
}

// Every spendable commodity set to 2x its OWN max-single-cost — comfortably below aiBarter's 5x
// surplus threshold for every commodity uniformly, and (since that's always > 0) comfortably
// above the "0" a test then sets on exactly one commodity to make it the unambiguous minimum. So
// a test can single out one clear surplus and one clear bottleneck without needing to know
// aiBarter's internal tie-break order (SPENDABLE's own fixed declaration order) to predict the rest.
function levelAiResources(state) {
  for (const com of SPENDABLE) state.players.ai.resources[com] = 2 * maxSingleCostFor(com);
}

test("aiBarter is a no-op when nothing is oversupplied past the surplus threshold", () => {
  const g = createGalaxy({ seed: 3 });
  const s = activeState(g);
  levelAiResources(s);
  const before = { ...s.players.ai.resources };
  assert.equal(aiBarter(s), null);
  assert.deepEqual(s.players.ai.resources, before, "resources are untouched on a no-op cycle");
});

test("aiBarter converts the AI's clearest surplus into its clearest bottleneck, moving both sides' market pressure", () => {
  const g = createGalaxy({ seed: 3 });
  const s = activeState(g);
  levelAiResources(s);
  s.players.ai.resources.ore = 100000;         // unambiguously the highest coverage
  s.players.ai.resources.radioactives = 0;     // unambiguously the lowest (strictly under the 50 baseline)
  const oreBefore = s.players.ai.resources.ore;
  const pressureOreBefore = s.market.pressure.ore || 0, pressureRadBefore = s.market.pressure.radioactives || 0;

  const trade = aiBarter(s);
  assert.ok(trade, "a real trade happens once something clears the surplus bar");
  assert.equal(trade.from, "ore");
  assert.equal(trade.to, "radioactives");
  assert.ok(trade.qty > 0 && trade.gained > 0);
  assert.equal(s.players.ai.resources.ore, oreBefore - trade.qty, "the surplus side pays out exactly qty");
  assert.equal(s.players.ai.resources.radioactives, trade.gained, "the bottleneck side receives exactly gained");
  assert.ok((s.market.pressure.ore || 0) < pressureOreBefore, "selling ore locally nudges its price down");
  assert.ok((s.market.pressure.radioactives || 0) > pressureRadBefore, "buying radioactives locally nudges its price up");
});

test("aiBarter never touches galaxy.credits — it's a same-planet conversion, not a sale", () => {
  const g = createGalaxy({ seed: 3 });
  const s = activeState(g);
  levelAiResources(s);
  s.players.ai.resources.ore = 100000;
  s.players.ai.resources.radioactives = 0;
  const creditsBefore = g.credits;
  assert.ok(aiBarter(s), "sanity: a real trade actually happens here");
  assert.equal(g.credits, creditsBefore, "galaxy.credits is never read or written by aiBarter");
});

test("aiBarter caps a single trade at one lot, even against an enormous surplus", () => {
  const g = createGalaxy({ seed: 3 });
  const s = activeState(g);
  levelAiResources(s);
  s.players.ai.resources.ore = 10_000_000;
  s.players.ai.resources.radioactives = 0;
  const trade = aiBarter(s);
  assert.equal(trade.qty, TRADE_LOT, "one lot per think-cycle, same lot size the player's own trades use");
});
