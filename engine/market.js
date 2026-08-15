/* ============================================================
   The Odyssey market — universal credits and per-planet commodity trading. Each
   world has its own price book: a commodity's equilibrium price is its global
   base value nudged by LOCAL abundance (a world rich in ore sells it cheap, a
   world short on it pays more), so moving goods between worlds is what turns a
   local surplus into portable, galaxy-wide credits.

   Prices react to your trades: dumping stock pushes a commodity's price down
   (and buying pushes it up), then the pressure decays back toward equilibrium
   over time — so a big trade is worth spreading across worlds and cycles rather
   than firing off all at once. Credits live on the galaxy (engine/galaxy.js),
   not the planet, so they carry with you when you jump.

   Deterministic and DOM-free like the rest of the engine: prices are a pure
   function of the map's deposits and the running trade pressure.
   ============================================================ */

"use strict";

import { COM, PLANETS } from "../data.js";
import { UNITS, BUILDINGS, UPGRADES, SPENDABLE, clamp } from "./entities.js";

// EVERY commodity is tradeable — the whole catalog (data.js COM), so nothing you can hold is a
// dead counter. Equilibrium base prices come straight from the commodity table (COM.base), the
// single source of truth, so the two can never drift. Raws are priced by local abundance (a world
// rich in ore sells it cheap); manufactured goods — everything the Odyssey production chain makes,
// which no world deposits — are priced by the world's INDUSTRY rating and can be glutted, so
// make-here / sell-there is the whole point of building factories. The strategic goods (AI cores,
// antimatter, plasma torpedoes) are tradeable too: no market gate, so a surplus is always credits.
const TRADEABLE = Object.keys(COM);
const BASE = Object.fromEntries(TRADEABLE.map(id => [id, COM[id].base]));

export const TRADE_LOT = 25;      // units bought/sold per click
const SPREAD = 1.15;              // a buy costs 15% more than the matching sell — the market's cut on refined goods
// Raw inputs cost MUCH more to buy than to sell. The game's law is "the resources you
// gather are the resources you spend" (entities.js) — you're meant to mine ore, not buy
// it. A tight spread let credits→ore→refine→metals→credits round-trip for free on a
// single world (the "credit printer"); a wide raw spread means a local buy-refine-sell
// loop loses money, so profit only comes from a real inter-world price gap (haul-and-sell).
const RAW_SPREAD = 1.5;
const RAW = new Set(TRADEABLE.filter(c => COM[c].tier === "Raw"));   // the deposited/gathered commodities (data.js COM.tier)
const SLIP_PER_LOT = 0.05;        // each lot traded moves the (fast) price pressure this much
// Exported so the LOAD path (engine/persist.js) clamps a saved price book into exactly the band
// applySlippage keeps it in at runtime. They used to be private, and the load path enforced
// nothing at all — a tampered pressure of 1e6 gave a 5,000,005-credit sale price, a negative one
// made selling LOSE credits, and a string made galaxy.credits permanently NaN (updateMarket is a
// multiplicative relaxation, so it never self-heals).
export const PRESSURE_FLOOR = -0.6, PRESSURE_CEIL = 0.6;   // price swings within 40%..160% of equilibrium
const RECOVERY = 0.06;            // pressure relaxes toward equilibrium at this rate per second (~17s constant)
// A SLOW, deep saturation term on FACTORY OUTPUT only: dumping produced goods on one
// world builds a cumulative glut that decays over minutes, not the ~17s of pressure. So
// a run of production genuinely floods its local market and pushes you to the intended
// make-here / sell-there loop (cargoManifest/freightCapacity exist for exactly this),
// instead of letting one world absorb unlimited output at a near-flat price.
const GLUT_PER_LOT = 0.05;        // each lot of produced output sold deepens the local glut this much
export const GLUT_CEIL = 0.85;    // a fully-saturated local market pays as little as 15% of equilibrium
const GLUT_RECOVERY = 1 / 480;    // glut relaxes over ~8 min — far slower than pressure

function buySpread(com) { return RAW.has(com) ? RAW_SPREAD : SPREAD; }

// ALLIED TRADE DISCOUNT (Gifts and favor requests: an actual road to Allied, engine/diplomacy.js):
// once a world's neighbour reaches Allied (diplomacy.js stanceLabel's own >= 0.6 band), the
// market rewards the friendship by tightening the buy-side spread — trust as a market yield, not
// just a peaceful border. Ramps linearly from the ordinary spread AT the Allied threshold to
// ALLIED_SPREAD at full alliance (stance 1.0), so crossing into Allied is a promise of more to
// come, not a cliff. A local constant rather than an import from diplomacy.js: diplomacy.js
// already imports TRADE_LOT/unitPrice FROM this module (its own favor-request pricing), so the
// other direction would be a cycle — market.js only ever reads state.diplomacy.stance as plain
// data, per the proposal's own framing.
const ALLIED_STANCE = 0.6;
const ALLIED_SPREAD = 1.05;

function effectiveBuySpread(state, com) {
  const spread = buySpread(com);
  const stance = state && state.diplomacy && state.diplomacy.stance;
  if (!(stance >= ALLIED_STANCE)) return spread;   // no diplomacy (skirmish), or short of Allied ⇒ unchanged
  const t = clamp((stance - ALLIED_STANCE) / (1 - ALLIED_STANCE), 0, 1);
  return spread - (spread - ALLIED_SPREAD) * t;
}

// Build a planet's price book: equilibrium price per tradeable commodity, scaled
// by how abundant that commodity is in the planet's own deposits.
// Manufactured goods (engine/industry.js) that no world deposits — priced by the
// world's INDUSTRY rating instead of by local ore: an industrial world floods its
// own finished-goods market (cheap, pays little), a frontier world can't make them
// so pays dear. This is what gives a low-industry world an economic niche.
// Everything that isn't a deposited raw is MANUFACTURED (data.js COM.tier ≠ Raw): no world deposits
// it, so it's priced by the world's industry rating and saturates (gluts) when dumped — the same
// treatment metals/alloys always had, now applied to the whole production chain up through the
// strategic goods (AI cores, antimatter, plasma torpedoes).
const PRODUCED = new Set(TRADEABLE.filter(c => COM[c].tier !== "Raw"));

export function createMarket(state) {
  const total = {}; let sum = 0;
  // SEED DEPOSITS ONLY — battlefield debris is not part of a world's price book. Wreck
  // (engine/wreckage.js) and crater (engine/bomb.js) nodes are pushed onto state.map.nodes
  // DURING play, and this function runs exactly twice in a world's life: once at creation
  // (engine/galaxy.js buildPlanetState, when no debris exists yet) and once on load
  // (engine/persist.js, AFTER rehydratePlanet has restored that debris). Counting it would
  // therefore derive `base` from a strictly larger node set on load than at creation, and
  // since `sum` moves, EVERY raw commodity's share moves with it — a saved world came back
  // quoting a different price book than the one it was played on, drifting further the more
  // wreckage accumulated (measured: radioactives 27 -> 34 with two wreck nodes).
  // Skipping them makes load reproduce creation exactly, and matches what the game already
  // does during play: wreckage does NOT move prices while you play, because createMarket is
  // not called again. Same `!n.wreck && !n.crater` exclusion engine/wreckage.js's own
  // worldHasCommodity gate uses, and for the same reason — synthesized debris must not be
  // mistaken for what the world actually deposits.
  for (const n of state.map.nodes) {
    if (n.wreck || n.crater) continue;
    total[n.com] = (total[n.com] || 0) + n.max; sum += n.max;
  }
  const industry = PLANETS.find(p => p.id === state.planetId)?.industry ?? 5;
  const base = {}, pressure = {}, glut = {};
  for (const com of TRADEABLE) {
    let mult;
    if (PRODUCED.has(com)) {
      // Pivot at industry 5 → 1.5× (today's flat ceiling, so this is continuous):
      // Forge (10) → ~1.05×, Vesper (5) → 1.5×, Oort (2) → ~1.77×. A moderate slope
      // so industrializing still out-earns overall (Forge's speed edge dominates) —
      // this only narrows the gap and keeps frontier factories worth running.
      mult = clamp(1.5 - (industry - 5) * 0.09, 0.9, 1.9);
    } else {
      const share = sum ? (total[com] || 0) / sum : 0;         // 0..1 local abundance
      mult = clamp(1.5 - share * 3.2, 0.6, 1.5);               // abundant → 0.6x, absent → 1.5x
    }
    base[com] = Math.max(1, Math.round(BASE[com] * mult));
    pressure[com] = 0;
    glut[com] = 0;
  }
  return { base, pressure, glut };
}

// Current unit price for a side of the trade. The (fast) pressure and the (slow) glut
// both push the equilibrium price down as you sell; the buy side pays the tier spread
// on top. Glut applies only to produced goods (it's zero for raws), so it's the lever
// that saturates a factory-output market without touching raw-commodity pricing.
// `state` is optional and ONLY changes the buy side: pass it (buy() and the HUD's own buy
// preview do) to apply the Allied trade discount above; every other call site (aiBarter, the
// many `unitPrice(market, com, side)` 3-arg reads throughout this file and hudSelection.js's
// sell-side quotes) is byte-identical to before — omitting it is not an approximation, it's the
// same ordinary-spread formula this function has always used.
export function unitPrice(market, com, side = "sell", state = null) {
  const glut = PRODUCED.has(com) ? (market.glut?.[com] || 0) : 0;
  const p = market.base[com] * (1 + (market.pressure[com] || 0)) * (1 - glut);
  if (side !== "buy") return p;
  return p * (state ? effectiveBuySpread(state, com) : buySpread(com));
}

// Move `com`'s pressure (and, for produced goods, its glut) by one lot's worth of trade,
// signed +1 for a buy, -1 for a sell. Fractional lots (a partial final lot) scale it.
function applySlippage(market, com, lots, sign) {
  market.pressure[com] = clamp((market.pressure[com] || 0) + sign * lots * SLIP_PER_LOT, PRESSURE_FLOOR, PRESSURE_CEIL);
  if (sign < 0 && PRODUCED.has(com))   // only SELLING produced output deepens the glut
    market.glut[com] = clamp((market.glut[com] || 0) + lots * GLUT_PER_LOT, 0, GLUT_CEIL);
}

// Sell up to `qty` of `com` from the player's local stock for galaxy credits, walking the
// price DOWN across the trade in TRADE_LOT chunks so a big sell is priced marginally (each
// lot at the price after the previous lot's slippage) instead of the whole quantity at the
// pre-trade price. That makes bulk trades self-limiting by construction — a future "Sell
// All" can't dump 1000 units at full price. The 25-per-click UI trades exactly one lot, so
// its numbers are unchanged. Returns the credits earned (0 if nothing sold).
export function sell(galaxy, state, com, qty) {
  const res = state.players.player.resources;
  let remaining = Math.min(qty, Math.floor(res[com] || 0));
  if (remaining <= 0) return 0;
  let proceeds = 0;
  while (remaining > 0) {
    const lot = Math.min(TRADE_LOT, remaining);
    proceeds += Math.round(unitPrice(state.market, com, "sell") * lot);
    res[com] -= lot;
    applySlippage(state.market, com, lot / TRADE_LOT, -1);
    remaining -= lot;
  }
  galaxy.credits += proceeds;
  return proceeds;
}

// Dry-run sell()'s exact lot walk without touching the real market or the player's stock — the
// bulk-trade UI's Sell x4 / Sell All tooltip calls this so its preview can never drift from what
// sell() will actually pay (the whole reason this exists instead of the UI re-deriving marginal
// pricing itself). Walks the SAME TRADE_LOT chunks against a scratch copy of just the two fields
// applySlippage mutates (pressure/glut for this one commodity) — cheaper than cloning the whole
// market, and just as isolated, since nothing else sell()'s loop reads or writes is touched.
// Returns the credits it would earn (0 for a zero/negative qty). Callers are expected to have
// already clamped `qty` to what's actually held (sell() itself clamps again regardless), same as
// every other quantity this module takes.
export function quoteSell(market, com, qty) {
  let remaining = Math.floor(qty);
  if (!(remaining > 0)) return 0;
  const scratch = { base: market.base, pressure: { ...market.pressure }, glut: { ...market.glut } };
  let proceeds = 0;
  while (remaining > 0) {
    const lot = Math.min(TRADE_LOT, remaining);
    proceeds += Math.round(unitPrice(scratch, com, "sell") * lot);
    applySlippage(scratch, com, lot / TRADE_LOT, -1);
    remaining -= lot;
  }
  return proceeds;
}

// Buy up to `qty` of `com` with galaxy credits (capped by what you can afford), walking the
// price UP across the trade in lots — the buy-side mirror of sell(). Each lot is priced and
// afford-checked at the current (rising) price; the trade stops at the first lot the player
// can't cover. Returns the credits spent (0 if nothing bought). Passes `state` into unitPrice so
// an Allied world (state.diplomacy.stance) buys at the tightened spread — see effectiveBuySpread.
export function buy(galaxy, state, com, qty) {
  const res = state.players.player.resources;
  let remaining = qty, cost = 0, bought = 0;
  while (remaining > 0) {
    const price = unitPrice(state.market, com, "buy", state);
    const lot = Math.min(TRADE_LOT, remaining);
    const affordable = Math.min(lot, Math.floor((galaxy.credits - cost) / price));
    if (affordable <= 0) break;
    cost += Math.round(price * affordable);
    res[com] = (res[com] || 0) + affordable;
    bought += affordable;
    applySlippage(state.market, com, affordable / TRADE_LOT, +1);
    if (affordable < lot) break;   // ran out of credits mid-lot
    remaining -= lot;
  }
  galaxy.credits -= cost;
  return cost;
}

// Relax every commodity's trade pressure back toward equilibrium (called per tick
// for a planet that has a market — see sim.js). The slow glut on produced goods relaxes
// on its own, much longer, time constant, so a saturated market takes minutes to recover.
export function updateMarket(state, dt) {
  const p = state.market.pressure;
  const k = Math.min(1, dt * RECOVERY);
  for (const com in p) p[com] -= p[com] * k;
  const g = state.market.glut;
  if (g) { const kg = Math.min(1, dt * GLUT_RECOVERY); for (const com in g) g[com] -= g[com] * kg; }
}

// Commodities worth showing on this world's market: those it deposits, plus any
// the player is currently carrying (so you can always offload what you hold).
export function tradeables(state) {
  return TRADEABLE.filter(c => commodityAvailable(state, "player", c));
}

// Can `owner` get hold of `com` on this world at all? A local deposit is one way; already HOLDING
// some is the other, and on a galaxy world that stock can arrive by freight lane, by freighter, or
// by purchase. The single definition of that rule, because the HUD used to carry its own copy that
// had dropped the second half — so shipping gas to a gas-free world let the engine accept a Wraith
// order while the button was ABSENT from the barracks panel entirely: not greyed, not explained.
export function commodityAvailable(state, owner, com) {
  const present = state.map.nodes.some(n => n.com === com);
  const res = state.players[owner] ? state.players[owner].resources : null;
  return present || (res ? (res[com] || 0) > 0 : false);
}

/* ---------- AI barter (Tier 3 of the section-08 economic-dial proposal) ---------- */

// A fixed, deterministic iteration order over every commodity anything in the game actually
// costs — SPENDABLE (entities.js) is a Set built by walking UNITS/BUILDINGS/UPGRADES in their
// own fixed declaration order, so this is stable run to run: the tie-break for "most/least
// surplus" below is simply "first encountered in this order", never an unseeded sort.
const SPENDABLE_ORDER = [...SPENDABLE];

// The largest amount any SINGLE unit/building/upgrade ever costs of `com` — computed once, the
// "one big purchase" yardstick both surplus and bottleneck are measured against below, so the
// two read on the same scale regardless of how differently priced two commodities are (a
// world drowning in 500 radioactives and one drowning in 500 ore aren't equally oversupplied
// if a single Colony Ship alone costs 500 ore).
const MAX_SINGLE_COST = (() => {
  const max = {};
  for (const d of [...Object.values(UNITS), ...Object.values(BUILDINGS), ...Object.values(UPGRADES)])
    for (const [com, qty] of Object.entries(d.cost || {})) max[com] = Math.max(max[com] || 0, qty);
  return max;
})();

const BARTER_LOT = TRADE_LOT;        // same lot size the player's own trades use
const SURPLUS_COVER = 5;             // holding > 5x the priciest single purchase ⇒ nothing to spend this on soon

// One AI barter trade this think-cycle, all priced off THIS world's own live market — a
// same-planet CONVERSION, never touching galaxy.credits (there is no AI-side credit account;
// see engine/aiDifficulty.js's section-08 note on why sell/buy couldn't be reused as-is).
// Finds the AI's most oversupplied spendable commodity (coverage — resources held, in units of
// "how many of the priciest single purchase" — past SURPLUS_COVER) and its scarcest (lowest
// coverage), and converts one LOT of the former into the latter at the market's current
// sell/buy prices, applying the same slippage a player trade would. Returns
// `{ from, to, qty, gained }` on a real trade, `null` on a no-op cycle (nothing oversupplied
// enough yet, or fewer than two spendable commodities in play on this world).
export function aiBarter(state) {
  const market = state.market;
  const res = state.players.ai.resources;
  let surplus = null, surplusCover = SURPLUS_COVER;
  let short = null, shortCover = Infinity;
  for (const com of SPENDABLE_ORDER) {
    const cover = (res[com] || 0) / MAX_SINGLE_COST[com];
    if (cover > surplusCover) { surplusCover = cover; surplus = com; }
    if (cover < shortCover) { shortCover = cover; short = com; }
  }
  if (!surplus || !short || surplus === short) return null;   // nothing oversupplied, or only one commodity in play

  const qty = Math.min(BARTER_LOT, Math.floor(res[surplus]));
  if (qty <= 0) return null;
  const rate = unitPrice(market, surplus, "sell") / unitPrice(market, short, "buy");
  const gained = qty * rate;

  res[surplus] -= qty;
  res[short] = (res[short] || 0) + gained;
  applySlippage(market, surplus, qty / BARTER_LOT, -1);
  applySlippage(market, short, gained / BARTER_LOT, +1);
  return { from: surplus, to: short, qty, gained };
}
