import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, jumpCapital, galaxyStatus, stepGalaxy, BG_STEP, ODYSSEY_WORLDS,
         upgradeToCapital, jumpVessel, canJump, canJumpTo, jumpCost, checkGalaxyRescue, surrenderGalaxy, RELIEF_COOLDOWN, JUMP_COST,
         CAPITAL_UPGRADE_COST, CAPITAL_HP_MULT,
         jumpManifest, jumpCapacity, spaceportTier, upgradeSpaceport, checkGalaxyProgress,
         SPACEPORT_MAX_TIER, SPACEPORT_CAPACITY, BACKGROUND_WORLDS } from "../engine/galaxy.js";
import { checkEndlessLoss } from "../engine/victory.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip, hasColonyShip } from "../engine/colony.js";
import { tick } from "../engine/sim.js";
import { jumpReadyGalaxy, liveWorld } from "./_helpers.js";

const commandCenters = (state, owner) =>
  [...state.buildings.values()].filter(b => b.owner === owner && b.type === "command");
// Odyssey now starts each side with a colony ship, not a placed CC. Deploying both
// reconstitutes the classic layout (a CC + 3 workers at each base) — used by tests that
// exercise DOWNSTREAM mechanics (jump/cargo/capital/domination), not the opening itself.
function settle(state) {
  for (const u of [...state.units.values()]) if (u.type === "colonyship") deployColonyShip(state, u.id);
  return state;
}
const playerBuildings = (state, type) =>
  [...state.buildings.values()].filter(b => b.owner === "player" && (!type || b.type === type));

// Stand a finished Spaceport beside the capital so a jump can launch, and return it.
function addSpaceport(state) {
  const cc = commandCenters(state, "player")[0];
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);   // no { constructing } ⇒ finished
  state.buildings.set(sp.id, sp);
  return sp;
}

test("createGalaxy lands the player on one world with a colony ship (no CC yet)", () => {
  const g = createGalaxy({ seed: 7, difficulty: "medium" });
  assert.ok(ODYSSEY_WORLDS.includes(g.activeId), "the start world is one of the roster");
  assert.equal(g.discovered.size, 1, "the player has REACHED exactly one world (the start seat)");
  assert.equal(g.planets.size, BACKGROUND_WORLDS + 1, "…but the living galaxy simulates the seat plus a seeded few worlds in the background from the start");
  assert.ok(g.credits > 0, "you start with a credit stipend to fund the first jump");
  const s = activeState(g);
  assert.equal(s.endless, true, "the active planet is an endless (Odyssey) state");
  assert.equal(commandCenters(s, "player").length, 0, "no Command Center is placed yet — you deploy one");
  assert.ok(hasColonyShip(s, "player"), "the player starts with a mobile colony ship");
  assert.ok(hasColonyShip(s, "ai"), "the neighbour likewise starts with a colony ship");
  settle(s);
  assert.equal(commandCenters(s, "player").length, 1, "deploying the ship founds exactly one Command Center");
  assert.ok(commandCenters(s, "ai").length >= 1, "a neighbour is present to coexist / clash with");
});

/* ---------- choosing (or rerolling) the starting world ---------- */

test("createGalaxy honors an explicit opts.startId, and records the choice in galaxy.settings", () => {
  const g = createGalaxy({ seed: 7, startId: "helix" });
  assert.equal(g.activeId, "helix", "the explicit start world is the active seat");
  assert.ok(g.discovered.has("helix"), "the chosen world is the one REACHED at creation");
  assert.equal(g.settings.startId, "helix", "the choice is recorded on galaxy.settings");
});

test("an unrecognised startId is ignored and falls back to the same random draw as omitting it", () => {
  const base = createGalaxy({ seed: 7 });
  const bogus = createGalaxy({ seed: 7, startId: "not-a-real-world" });
  assert.equal(bogus.activeId, base.activeId, "a bogus startId behaves exactly like no startId at all");
});

test("choosing a start world still consumes the seed's random draw, so every OTHER world's own generation is unaffected", () => {
  const seed = 7;
  const g1 = createGalaxy({ seed });                              // the natural, random draw
  const chosen = ODYSSEY_WORLDS.find(w => w !== g1.activeId);     // deliberately a DIFFERENT world
  const g2 = createGalaxy({ seed, startId: chosen });
  assert.equal(g2.activeId, chosen, "the explicit choice wins over the draw");

  // planetSeed(seed, planetId) — every world's own per-planet seed — is a pure function of the
  // galaxy seed and that world's id, independent of which world became the start seat. So a
  // world that's a BACKGROUND world in both galaxies must generate byte-identically either way:
  // proof that resolving an explicit startId doesn't perturb any other world's RNG stream.
  const common = ODYSSEY_WORLDS.find(w => w !== g1.activeId && w !== g2.activeId);
  // Built in explicitly where the seeded background draw (which is keyed on the start world) didn't
  // happen to bring it up: the point here is that the per-planet SEED is start-world-independent,
  // not which handful of worlds each galaxy chose to simulate.
  const inG1 = g1.planets.get(common) || addPlanet(g1, common, { unsettled: true });
  const inG2 = g2.planets.get(common) || addPlanet(g2, common, { unsettled: true });
  assert.deepEqual(inG2.map.nodes, inG1.map.nodes,
    "a world untouched by the start-world choice generates identically either way");
});

test("an explicit startId that matches the natural draw reproduces the same galaxy", () => {
  const seed = 21;
  const base = createGalaxy({ seed });
  const explicit = createGalaxy({ seed, startId: base.activeId });
  assert.equal(explicit.activeId, base.activeId);
  assert.deepEqual([...explicit.planets.keys()].sort(), [...base.planets.keys()].sort());
});

test("endless mode never ends by conquest — razing the enemy CC does not win", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  for (const b of commandCenters(s, "ai")) s.buildings.delete(b.id);   // wipe the neighbour's CC
  checkEndlessLoss(s);
  assert.equal(s.over, false, "losing the enemy CC is not a victory in the open world");
});

test("endless mode ends in defeat only when the player's last foothold is lost", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  checkEndlessLoss(s);
  assert.equal(s.over, false, "a lone colony ship is a foothold — not a tick-1 defeat");
  settle(s);                                                    // deploy the ship → a CC + workers
  for (const b of commandCenters(s, "player")) s.buildings.delete(b.id);   // the capital falls (no ship left, it deployed)
  checkEndlessLoss(s);
  assert.equal(s.over, true, "with no CC and no colony ship, the Odyssey is over");
  assert.equal(s.winner, "ai");
});

test("a second Command Center is an expansion — losing one doesn't end the Odyssey", () => {
  const s = settle(createGameState({ planetId: "ferros", seed: 3, endless: true }));
  const first = commandCenters(s, "player")[0];
  const second = makeBuilding("command", "player", first.x + 300, first.y + 200);   // an expansion base
  s.buildings.set(second.id, second);
  assert.equal(commandCenters(s, "player").length, 2, "the player can hold multiple CCs in Odyssey");
  s.buildings.delete(first.id);                     // the original capital falls…
  checkEndlessLoss(s);
  assert.equal(s.over, false, "…but the expansion CC keeps the Odyssey alive");
  s.buildings.delete(second.id);                    // now the last one falls
  checkEndlessLoss(s);
  assert.equal(s.over, true, "only the LAST Command Center ends the run");
});

test("a jump carries a colony ship, NOT a deployed base — the bases stay behind as a colony", () => {
  const g = createGalaxy({ seed: 7 });
  const from = settle(activeState(g));
  const cc = commandCenters(from, "player")[0];
  const expansion = makeBuilding("command", "player", cc.x + 300, cc.y + 200);
  from.buildings.set(expansion.id, expansion);      // two deployed bases
  const sp = addSpaceport(from);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y);   // the jump vessel, staged on the pad
  from.units.set(ship.id, ship);
  g.credits = 2000;
  const destId = g.worlds.find(w => w !== g.activeId);
  assert.ok(jumpCapital(g, destId), "the jump launched");
  const dest = activeState(g);
  assert.equal(commandCenters(dest, "player").length, 0, "NO deployed base teleported to the destination");
  assert.ok(hasColonyShip(dest, "player"), "the colony ship arrived — deploy it to settle here");
  assert.equal(commandCenters(from, "player").length, 2, "both deployed bases stayed behind on the colony");
});

test("a Command Center upgrades into the Capital — double HP, charged, one per owner", () => {
  const s = settle(createGameState({ planetId: "ferros", seed: 3, endless: true }));
  const cc = commandCenters(s, "player")[0];
  const baseMax = cc.maxHp;
  s.players.player.resources.ore = 1000;
  assert.equal(upgradeToCapital(s, cc), true, "the upgrade succeeds when affordable");
  assert.equal(cc.capital, true, "it is now the Capital");
  assert.equal(cc.maxHp, baseMax * CAPITAL_HP_MULT, "double the HP");
  assert.equal(s.players.player.resources.ore, 1000 - CAPITAL_UPGRADE_COST.ore, "the cost was charged");

  const second = makeBuilding("command", "player", cc.x + 300, cc.y);
  s.buildings.set(second.id, second);
  s.players.player.resources.ore = 1000;
  assert.equal(upgradeToCapital(s, second), false, "only one Capital per owner");
  assert.ok(!second.capital, "the second CC stays a normal (jumping) base");
});

test("upgradeToCapital is refused without the resources or on a still-constructing CC", () => {
  const s = settle(createGameState({ planetId: "ferros", seed: 3, endless: true }));
  const cc = commandCenters(s, "player")[0];
  s.players.player.resources.ore = 10;                 // can't afford
  assert.equal(upgradeToCapital(s, cc), false);
  assert.ok(!cc.capital);
  const half = makeBuilding("command", "player", cc.x + 300, cc.y);
  half.constructing = true;
  s.buildings.set(half.id, half);
  s.players.player.resources.ore = 1000;
  assert.equal(upgradeToCapital(s, half), false, "a half-built CC can't be the Capital yet");
});

test("a jump launches from a Spaceport alone (no colony-ship mandate) and never carries a deployed base", () => {
  const g = createGalaxy({ seed: 7 });
  const from = settle(activeState(g));
  const cc = commandCenters(from, "player")[0];
  const sp = addSpaceport(from);
  g.credits = 2000;
  from.players.player.resources.ore = 1000;
  upgradeToCapital(from, cc);                           // a fortified base
  assert.equal(jumpVessel(from), null, "no colony ship staged → no vessel loaded (a HUD hint, not a gate)");
  assert.ok(canJump(from), "a Spaceport alone can launch a jump — no colony ship required");
  const destId = g.worlds.find(w => w !== g.activeId);
  assert.ok(jumpCapital(g, destId), "the jump runs with just a Spaceport (a scout/reinforce hop)");
  assert.equal(commandCenters(from, "player").length, 1, "the deployed base stayed put…");
  assert.equal(commandCenters(from, "player")[0].capital, true, "…still the fortified Capital");
  assert.equal(commandCenters(activeState(g), "player").length, 0, "and nothing was teleported to the destination");

  // With a colony ship staged near a pad, jumpVessel still identifies it (the HUD's "ship loaded?" cue).
  const here = activeState(g);
  const sp2 = makeBuilding("spaceport", "player", here.map.bases.player.x + 40, here.map.bases.player.y);
  here.buildings.set(sp2.id, sp2);
  const ship = makeUnit("colonyship", "player", sp2.x, sp2.y); here.units.set(ship.id, ship);
  assert.equal(jumpVessel(here)?.id, ship.id, "a staged colony ship is still reported as the loaded vessel");
});

test("the Capital (flag + raised HP) survives a galaxy save/load", () => {
  const g = createGalaxy({ seed: 5 });
  const s = settle(activeState(g));
  const cc = commandCenters(s, "player")[0];
  s.players.player.resources.ore = 1000;
  upgradeToCapital(s, cc);
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const rcc = commandCenters(activeState(restored), "player")[0];
  assert.equal(rcc.capital, true, "the Capital flag round-trips");
  assert.equal(rcc.maxHp, cc.maxHp, "the raised HP round-trips");
});

test("an endless state has no time-limit resolution", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.time = 100000;   // far beyond any skirmish clock
  checkEndlessLoss(s);
  assert.equal(s.over, false, "the sandbox does not resolve on a clock while the capital stands");
});

test("an Odyssey galaxy runs without ending while both capitals stand, and is deterministic", () => {
  const fingerprint = () => {
    const g = createGalaxy({ seed: 4242, difficulty: "medium" });
    const s = activeState(g);
    for (let i = 0; i < 200; i++) tick(s, 0.1);
    return `${g.activeId}|${s.over}|${s.tick}|${s.units.size}|${Math.round(s.players.player.resources.ore || 0)}`;
  };
  const a = fingerprint();
  assert.match(a, /\|false\|/, "the sandbox is still running after 20s (no premature end)");
  assert.equal(a, fingerprint(), "same galaxy seed replays identically");
});

/* ---------- background-world scheduling (stepGalaxy) ---------- */

// Seed a galaxy with `n` background worlds added alongside the active seat.
function galaxyWithBackground(seed, n) {
  const g = createGalaxy({ seed });
  const others = g.worlds.filter(w => w !== g.activeId).slice(0, n);
  for (const w of others) addPlanet(g, w, { unsettled: true });
  return { g, bg: others.map(w => g.planets.get(w)) };
}

test("stepGalaxy ticks the active world every frame and colonies on a coarser step", () => {
  const { g, bg } = galaxyWithBackground(5, 2);
  const active = activeState(g);
  for (let i = 0; i < BG_STEP; i++) stepGalaxy(g, 0.1);
  assert.equal(active.tick, BG_STEP, "the active world ticks every galaxy tick");
  for (const s of bg) assert.equal(s.tick, 1, "a background world ticks once per BG_STEP window");
  // Sim time is conserved despite the coarser cadence.
  for (const s of bg) assert.ok(Math.abs(s.time - active.time) < 1e-9, "same sim time elapsed");
});

test("every background world ticks exactly once per BG_STEP window", () => {
  const { g, bg } = galaxyWithBackground(6, 5);
  for (let i = 0; i < BG_STEP; i++) stepGalaxy(g, 0.1);
  for (const s of bg) assert.equal(s.tick, 1, "each colony advanced exactly one coarse step");
});

test("stepGalaxy scheduling is deterministic for a given seed", () => {
  const run = () => {
    const { g, bg } = galaxyWithBackground(424242, 3);
    for (let i = 0; i < 40; i++) stepGalaxy(g, 0.1);
    const a = activeState(g);
    return `${a.tick}|${a.units.size}|${bg.map(s => `${s.tick}:${s.units.size}`).join(",")}|${Math.round(g.credits)}`;
  };
  assert.equal(run(), run(), "same seed + same stepGalaxy sequence replays identically");
});

test("addPlanet builds a distinct, deterministic world into the galaxy", () => {
  const g = createGalaxy({ seed: 11 });
  const other = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  const s1 = addPlanet(g, other);
  assert.equal(s1.endless, true);
  assert.equal(s1.planetId, other);
  // Rebuilding the same world from the same galaxy seed is identical (per-planet seed).
  const g2 = createGalaxy({ seed: 11 });
  const s2 = addPlanet(g2, other);
  assert.equal(s1.seed, s2.seed, "per-planet seed is stable across galaxies of the same seed");
});

test("an unsettled destination has only its neighbour — no auto-seeded player base", () => {
  const g = createGalaxy({ seed: 12 });
  const other = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  const s = addPlanet(g, other, { unsettled: true });
  assert.equal(playerBuildings(s).length, 0, "no player buildings until you land");
  assert.equal([...s.units.values()].filter(u => u.owner === "player").length, 0, "no player units either");
  assert.ok([...s.units.values()].some(u => u.owner === "ai"), "the neighbour is intact (its colony ship)");
  assert.equal(s.background, true, "an unvisited world is a background world");
});

/* ---------- the interplanetary jump ---------- */

test("a jump carries the colony ship + staged units and leaves the base as a colony", () => {
  const g = createGalaxy({ seed: 5, difficulty: "easy" });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y);        from.units.set(ship.id, ship);   // the vessel
  const rider = makeUnit("skiff", "player", sp.x + 20, sp.y);       from.units.set(rider.id, rider);
  const stayer = makeUnit("worker", "player", sp.x + 900, sp.y);    from.units.set(stayer.id, stayer);

  const destId = g.worlds.find(w => w !== g.activeId);
  const res = jumpCapital(g, destId);
  assert.ok(res, "the jump ran");
  assert.equal(g.activeId, destId, "the destination is now active");

  const dest = activeState(g);
  assert.ok(hasColonyShip(dest, "player"), "the colony ship arrived at the destination");
  assert.ok([...dest.units.values()].some(u => u.owner === "player" && u.type === "skiff"), "the staged unit rode along");
  assert.equal(commandCenters(dest, "player").length, 0, "no deployed base teleported");

  assert.equal(from.background, true, "the origin is now a background colony");
  assert.equal(dest.background, false, "the destination is the active seat");
  assert.equal(commandCenters(from, "player").length, 1, "the origin KEEPS its base as a colony");
  assert.ok(playerBuildings(from, "spaceport").length === 1, "the Spaceport stays with the colony");
  assert.ok([...from.units.values()].some(u => u.owner === "player" && u.type === "worker" && u.x === stayer.x),
    "far units stay with the colony");
});

test("a jump destination receives the colony ship (and staged units), no teleported base", () => {
  const g = createGalaxy({ seed: 6 });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y); from.units.set(ship.id, ship);
  const destId = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, destId);
  const dest = g.planets.get(destId);
  assert.equal(playerBuildings(dest).length, 0, "no player building teleported — you deploy the ship to found one");
  assert.ok(hasColonyShip(dest, "player"), "the colony ship is the player's presence on arrival");
  assert.ok([...dest.units.values()].some(u => u.owner === "ai"), "the destination's neighbour is intact (its colony ship)");
});

test("after a jump the abandoned colony keeps evolving and never ends the game", () => {
  const g = createGalaxy({ seed: 7 });
  const from = settle(activeState(g));
  addSpaceport(from);
  const destId = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, destId);
  for (let i = 0; i < 100; i++) for (const s of g.planets.values()) tick(s, 0.1);
  assert.equal(from.over, false, "a colony with no capital is not 'over'");
  assert.equal(activeState(g).over, false, "the active seat with its capital keeps running");
});

test("galaxyStatus reports one seat and the rest unexplored, then a colony after a jump", () => {
  const g = createGalaxy({ seed: 21 });
  let st = galaxyStatus(g);
  assert.equal(st.total, ODYSSEY_WORLDS.length);
  assert.equal(st.visited, 1);
  assert.equal(st.worlds.filter(w => w.status === "seat").length, 1, "exactly one active seat");
  assert.equal(st.worlds.filter(w => w.status === "unexplored").length, ODYSSEY_WORLDS.length - 1, "everything else unexplored");
  assert.equal(st.worlds.find(w => w.status === "seat").id, g.activeId);

  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  from.units.set(...(() => { const sh = makeUnit("colonyship", "player", sp.x, sp.y); return [sh.id, sh]; })());   // vessel
  g.credits = 1000;
  const dest = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, dest);
  st = galaxyStatus(g);
  assert.equal(st.visited, 2);
  assert.equal(st.worlds.find(w => w.id === dest).status, "seat", "the destination is the new seat");
  const colony = st.worlds.find(w => w.status === "colony");
  assert.ok(colony, "the world left behind is a colony");
  assert.ok(colony.income > 0, "a held colony reports passive income");

  // Raze that colony's buildings — it's no longer yours, so it reads "contested".
  const cs = activeState(g).planetId === colony.id ? null : g.planets.get(colony.id);
  for (const b of [...cs.buildings.values()]) if (b.owner === "player") cs.buildings.delete(b.id);
  st = galaxyStatus(g);
  assert.equal(st.worlds.find(w => w.id === colony.id).status, "contested", "a razed colony is contested, not yours");
});

test("the galaxy jump is deterministic", () => {
  const run = () => {
    const g = createGalaxy({ seed: 88, difficulty: "medium" });
    const home = settle(activeState(g));
    const sp = addSpaceport(home);
    home.units.set(...(() => { const sh = makeUnit("colonyship", "player", sp.x, sp.y); return [sh.id, sh]; })());
    const destId = g.worlds.find(w => w !== g.activeId);
    jumpCapital(g, destId);
    const dest = activeState(g), from = g.planets.get([...g.planets.keys()].find(k => k !== g.activeId));
    return `${g.activeId}|${dest.units.size}|${dest.buildings.size}|${from.units.size}|${from.buildings.size}`;
  };
  assert.equal(run(), run(), "same seed + same jump replays identically");
});

/* ---------- free travel between held worlds + galaxy-wide defeat ---------- */

test("a jump is free to a world you already hold and costs distance-scaled fuel to reach a new one", () => {
  const g = createGalaxy({ seed: 33 });
  settle(activeState(g));
  const newWorld = g.worlds.find(w => !g.discovered.has(w));   // a world the player hasn't reached (though it simulates)
  assert.ok(jumpCost(g, newWorld) > 0, "reaching a never-visited world costs fuel");
  g.discovered.add(newWorld);                                  // now it's a world you've been to
  assert.equal(jumpCost(g, newWorld), 0, "returning to a world you've reached is free");
  assert.equal(jumpCost(g, g.activeId), 0, "your current seat is free too");
});

test("new-world jump fuel scales with frontier distance", () => {
  const g = createGalaxy({ seed: 33 });
  // Rank the unvisited worlds by |x - activeX|; the farthest must cost strictly more fuel
  // than the nearest — the distance sink, not a flat fee.
  const costs = g.worlds.filter(w => !g.discovered.has(w)).map(w => jumpCost(g, w));
  assert.ok(costs.length >= 2, "several worlds to reach");
  assert.ok(Math.max(...costs) > Math.min(...costs), "a farther world costs more fuel than a nearer one");
  assert.ok(Math.min(...costs) > 0, "every new world still costs something");
});

test("jumpCapital refuses a real jump when credits fall short of the actual cost — nothing about the galaxy changes", () => {
  const g = jumpReadyGalaxy(9);                              // a real jump-ready galaxy: pad, staged ship, funded
  const from = activeState(g);
  const activeIdBefore = g.activeId;
  const destId = liveWorld(g);                               // a never-visited world — a real, non-zero fuel cost
  const dest = g.planets.get(destId);
  const cost = jumpCost(g, destId);
  assert.ok(cost > 0, "reaching a fresh world costs real fuel");
  g.credits = cost - 1;                                       // short of the actual cost, not merely "poor"

  const fromBackgroundBefore = from.background, destBackgroundBefore = dest.background;
  const fromUnitsBefore = from.units.size, fromBuildingsBefore = from.buildings.size;
  const destUnitsBefore = dest.units.size, destBuildingsBefore = dest.buildings.size;

  const res = jumpCapital(g, destId);

  assert.equal(res, null, "the jump is refused when credits are short of the real cost");
  assert.equal(g.activeId, activeIdBefore, "the capital did not relocate");
  assert.equal(g.credits, cost - 1, "a refused jump doesn't spend the credits it couldn't afford");
  assert.equal(from.background, fromBackgroundBefore, "the origin is still the active seat, not left as a colony");
  assert.equal(dest.background, destBackgroundBefore, "the destination is untouched — still just a background world");
  assert.equal(from.units.size, fromUnitsBefore, "no staged rider left the origin");
  assert.equal(from.buildings.size, fromBuildingsBefore, "the origin's buildings are untouched");
  assert.equal(dest.units.size, destUnitsBefore, "nothing arrived at the destination");
  assert.equal(dest.buildings.size, destBuildingsBefore, "the destination gained no buildings");
  assert.ok(!g.discovered.has(destId), "the destination was never marked reached");
});

test("a free reinforcement hop back to a colony carries an army and spends no fuel", () => {
  const g = createGalaxy({ seed: 34 });
  const from = settle(activeState(g));
  // A colony we already hold (settled, then left as a background world).
  const colonyId = g.worlds.find(w => w !== g.activeId);
  const colony = addPlanet(g, colonyId, { unsettled: true });
  const colonyCC = makeBuilding("command", "player", colony.map.bases.player.x, colony.map.bases.player.y);
  colony.buildings.set(colonyCC.id, colonyCC);                 // it's ours: a standing base
  // Stage an army by our Spaceport back home — no colony ship, just reinforcements.
  const sp = addSpaceport(from);
  const trooper = makeUnit("skiff", "player", sp.x + 10, sp.y); from.units.set(trooper.id, trooper);
  g.credits = 500;
  const before = g.credits;
  const res = jumpCapital(g, colonyId);
  assert.ok(res, "the hop to a held colony runs");
  assert.equal(g.credits, before, "no fuel was spent returning to a world we hold");
  assert.equal(g.activeId, colonyId, "we're now controlling the colony");
  assert.ok([...activeState(g).units.values()].some(u => u.owner === "player" && u.type === "skiff"),
    "the staged army rode along to reinforce the colony");
});

test("holding a foothold on ANY world means no relief is sent (and never a defeat)", () => {
  const g = createGalaxy({ seed: 35 });
  const home = settle(activeState(g));                          // home has a CC
  // Jump (Spaceport only, no ship) to a fresh world where we hold nothing.
  addSpaceport(home);
  g.credits = 2000;
  const destId = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, destId);
  const dest = activeState(g);
  assert.equal(commandCenters(dest, "player").length, 0, "we hold nothing on the world we hopped to");
  assert.equal(hasColonyShip(dest, "player"), false, "…not even a colony ship");
  checkGalaxyRescue(g);
  assert.equal(dest.over, false, "never a defeat — a base stands back home");
  assert.ok(!hasColonyShip(dest, "player"), "and no relief ship is sent while a foothold stands somewhere");

  // The per-world check must stay quiet on a galaxy world (inGalaxy), even with no foothold here.
  checkEndlessLoss(dest);
  assert.equal(dest.over, false, "the per-world loss check is suppressed for a galaxy world");
});

test("a total wipeout is NOT a defeat — a relief colony ship is dispatched so life goes on", () => {
  const g = createGalaxy({ seed: 35 });
  const home = settle(activeState(g));
  g.time = 1000;                                               // galaxy-wide clock (relief keys on this, not a per-world time)
  for (const b of commandCenters(home, "player")) home.buildings.delete(b.id);   // raze the only base — no foothold anywhere
  assert.ok(!hasColonyShip(home, "player"), "and the start ship was consumed founding it — truly nothing left");
  checkGalaxyRescue(g);
  assert.equal(activeState(g).over, false, "the Odyssey does NOT end — you can't lose, only surrender");
  assert.ok(hasColonyShip(activeState(g), "player"), "a relief colony ship arrived to re-found from");
  assert.equal(g.reliefNote, true, "…and its arrival is flagged for a UI toast");

  // Relief is cooldown-bounded: razing that ship immediately doesn't spawn another the same tick.
  for (const [id, u] of [...activeState(g).units]) if (u.type === "colonyship") activeState(g).units.delete(id);
  checkGalaxyRescue(g);
  assert.ok(!hasColonyShip(activeState(g), "player"), "no second relief within the cooldown window");
  g.time += RELIEF_COOLDOWN + 1;                               // wait out the cooldown on the galaxy clock
  checkGalaxyRescue(g);
  assert.ok(hasColonyShip(activeState(g), "player"), "after the cooldown, relief comes again — life goes on");
});

test("relief cooldown keys on the galaxy clock, not the active world's local time (survives a jump)", () => {
  const g = createGalaxy({ seed: 42 });
  const home = settle(activeState(g));
  for (const b of commandCenters(home, "player")) home.buildings.delete(b.id);   // no foothold anywhere
  // The bug this guards: lastReliefTime was compared against the ACTIVE world's local
  // clock, but a jump swaps which world is active and each world's clock runs on its own.
  // Simulate a relief that dropped 5s ago on the galaxy clock, then a jump to a world whose
  // LOCAL clock reads ancient — keying on the local time would falsely read the cooldown as
  // long elapsed and farm relief; keying on the galaxy clock (the fix) does not.
  g.time = 10;
  g.lastReliefTime = 5;              // 5s ago on the galaxy clock — inside the 20s cooldown
  activeState(g).time = 100000;      // the active world's local clock is a red herring
  checkGalaxyRescue(g);
  assert.ok(!hasColonyShip(activeState(g), "player"), "still on cooldown by the galaxy clock — no premature relief");

  g.time = 30;                       // 25s since the last drop on the galaxy clock (> cooldown)
  checkGalaxyRescue(g);
  assert.ok(hasColonyShip(activeState(g), "player"), "past the cooldown on the galaxy clock — relief arrives");
});

test("a lone undeployed colony ship anywhere is a foothold — no relief needed, no defeat", () => {
  const g = createGalaxy({ seed: 36 });
  // Don't settle: the start world holds only the colony ship (no CC anywhere).
  assert.ok(hasColonyShip(activeState(g), "player"), "the start is a lone colony ship");
  const before = [...activeState(g).units.values()].filter(u => u.type === "colonyship").length;
  checkGalaxyRescue(g);
  assert.equal(activeState(g).over, false, "a lone colony ship can still re-found — not a defeat");
  assert.equal([...activeState(g).units.values()].filter(u => u.type === "colonyship").length, before,
    "no extra relief ship — the existing one is already a foothold");
});

test("surrender is the ONLY terminal state — it ends the Odyssey by the player's choice", () => {
  const g = createGalaxy({ seed: 37 });
  settle(activeState(g));
  assert.equal(activeState(g).over, false, "running");
  surrenderGalaxy(g);
  assert.equal(activeState(g).over, true, "surrender ends it");
  assert.equal(activeState(g).winner, "ai");
  assert.equal(g.surrendered, true, "…flagged as a surrender (drives the game-over copy)");
});

test("a surrendered game stays ended — checkGalaxyRescue's guard holds even with a real wipeout", () => {
  const g = createGalaxy({ seed: 38 });
  const home = settle(activeState(g));
  for (const b of commandCenters(home, "player")) home.buildings.delete(b.id);   // raze the only base…
  assert.ok(!hasColonyShip(home, "player"), "…and the start ship was consumed founding it — a true wipeout");

  surrenderGalaxy(g);
  assert.equal(activeState(g).over, true, "the surrender ended the run");

  checkGalaxyRescue(g);   // the wipeout conditions that would otherwise dispatch relief are still true

  assert.equal(activeState(g).over, true, "still over — a rescue must never un-end a surrendered game");
  assert.equal(activeState(g).winner, "ai", "the surrender's result stands");
  assert.ok(!hasColonyShip(activeState(g), "player"), "no relief colony ship is spawned once the game has been surrendered");
  assert.ok(!g.reliefNote, "…and no relief toast fires either");
});

/* ---------- stranded recovery: no catch-22 without a Spaceport ---------- */

test("canJumpTo: a Spaceport here reaches anywhere; without one, only a world you hold a base on", () => {
  const g = createGalaxy({ seed: 61 });
  const home = settle(activeState(g));                       // home: a Command Center (a base we hold)
  const homeId = g.activeId;
  // A world we hold NOTHING on (it simulates, but no base of ours), and another the same — neither
  // is a fallback without a Spaceport. (Every world is instantiated now, so both are just unheld ids.)
  const contestedId = g.worlds.find(w => w !== homeId);
  const freshId = g.worlds.find(w => w !== homeId && w !== contestedId);

  // No Spaceport here yet: we can fall back to our base, but not to a contested world or a new one.
  assert.equal(canJumpTo(g, homeId), false, "the world we're on is never a jump target");
  assert.equal(canJumpTo(g, contestedId), false, "a visited world with no base of ours is not a fallback");
  assert.equal(canJumpTo(g, freshId), false, "and a new world needs a Spaceport");

  // Now hop away so home isn't the active world, and confirm we can fall back TO it.
  addSpaceport(home);
  g.credits = 3000;
  jumpCapital(g, freshId);                                   // Spaceport here → open the new frontier
  assert.notEqual(g.activeId, homeId, "we left home");
  assert.equal(canJumpTo(g, homeId), true, "…and can always fall back to the base we hold");
});

test("stranded without a Spaceport, falling back to home is a CONTROL SWITCH — the fleet stays put (catch-22 fixed, no drag)", () => {
  const g = createGalaxy({ seed: 62 });
  const home = settle(activeState(g));
  const homeId = g.activeId;
  const sp = addSpaceport(home);
  const trooper = makeUnit("skiff", "player", sp.x, sp.y);   // an army staged on the pad — but NO colony ship
  home.units.set(trooper.id, trooper);
  g.credits = 3000;
  const newId = g.worlds.find(w => w !== homeId);
  jumpCapital(g, newId);                                     // hop the army over, forgetting the colony ship

  const stranded = activeState(g);
  assert.equal(commandCenters(stranded, "player").length, 0, "no base on the world we hopped to");
  assert.ok(![...stranded.buildings.values()].some(b => b.owner === "player" && b.type === "spaceport"),
    "and no Spaceport — the old rules would trap us here");
  const armyBefore = [...stranded.units.values()].filter(u => u.owner === "player" && u.type === "skiff").length;
  assert.equal(armyBefore, 1, "our army is here");

  // The fix: we can fall back to the base we hold — but it's a control switch, NOT an evacuation:
  // the fleet we transported over STAYS where we left it (we go back for a colony ship, not to drag it home).
  assert.ok(canJumpTo(g, homeId), "we can retreat to the base we hold");
  const before = g.credits;
  const res = jumpCapital(g, homeId);
  assert.ok(res, "the fallback jump runs");
  assert.equal(res.riders, 0, "no units ride a portless fallback — it's a pure control switch");
  assert.equal(g.credits, before, "returning to a world we hold is free");
  assert.equal(g.activeId, homeId, "we're back on our home world — where the colony ship is built");
  assert.equal([...g.planets.get(newId).units.values()].filter(u => u.owner === "player" && u.type === "skiff").length, 1,
    "the transported fleet stays on the world we left — it is NOT dragged back");
  assert.ok(![...activeState(g).units.values()].some(u => u.id === trooper.id),
    "…and it did not reappear on home");
});

test("a portless world still cannot open a NEW frontier — only a Spaceport expands", () => {
  const g = createGalaxy({ seed: 63 });
  const home = settle(activeState(g));
  addSpaceport(home);
  g.credits = 3000;
  const newId = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, newId);                                     // strand ourselves (no Spaceport at newId)
  const fresh = g.worlds.find(w => !g.planets.has(w));
  assert.equal(canJumpTo(g, fresh), false, "no Spaceport here → can't reach an unvisited world");
  assert.equal(jumpCapital(g, fresh), null, "…and the jump is refused");
});

test("live-built ids stay unique across worlds — visiting a new world can't reset the counter into a collision", () => {
  const g = createGalaxy({ seed: 64 });
  const home = settle(activeState(g));
  for (let i = 0; i < 15; i++) { const b = makeBuilding("turret", "player", 300 + i, 300); home.buildings.set(b.id, b); }
  const homeIds = new Set([...home.buildings.keys()]);
  addSpaceport(home);
  g.credits = 3000;
  jumpCapital(g, g.worlds.find(w => w !== g.activeId));   // visit a NEW world → addPlanet re-seeds it
  // The next thing built anywhere must not reuse an id already live on home (the old bug clobbered it).
  const fresh = makeBuilding("turret", "player", 500, 500);
  assert.ok(!homeIds.has(fresh.id), `a freshly minted id (${fresh.id}) must not collide with home's existing buildings`);
});

/* ---------- 3-tier Spaceport: supply-capacity jumps ---------- */

// A finished Spaceport placed FAR from the base, so the settle()'d workers near the CC
// aren't accidentally within the pad's staging radius — the fleet we stage is exactly what
// the test puts there.
function farSpaceport(state) {
  const base = state.map.bases.player;
  const sp = makeBuilding("spaceport", "player", base.x + 600, base.y + 600);
  state.buildings.set(sp.id, sp);
  return sp;
}

test("a Spaceport starts at Tier 1 and upgrades through Tier 3, raising jump capacity", () => {
  const s = settle(createGameState({ planetId: "ferros", seed: 3, endless: true }));
  const sp = addSpaceport(s);
  assert.equal(spaceportTier(sp), 1, "a fresh pad is Tier 1");
  assert.equal(jumpCapacity(sp), SPACEPORT_CAPACITY[1]);
  s.players.player.resources.ore = 10000;
  assert.equal(upgradeSpaceport(s, sp), true, "Tier 1 → 2");
  assert.equal(spaceportTier(sp), 2);
  assert.ok(jumpCapacity(sp) > SPACEPORT_CAPACITY[1], "capacity grows with the tier");
  assert.equal(upgradeSpaceport(s, sp), true, "Tier 2 → 3");
  assert.equal(spaceportTier(sp), SPACEPORT_MAX_TIER);
  assert.equal(jumpCapacity(sp), SPACEPORT_CAPACITY[SPACEPORT_MAX_TIER]);
  assert.equal(upgradeSpaceport(s, sp), false, "can't upgrade past the max tier");
});

test("upgradeSpaceport is refused when unaffordable or still constructing", () => {
  const s = settle(createGameState({ planetId: "ferros", seed: 3, endless: true }));
  const sp = addSpaceport(s);
  s.players.player.resources.ore = 0;
  assert.equal(upgradeSpaceport(s, sp), false, "no ore → no upgrade");
  assert.equal(spaceportTier(sp), 1);
  sp.constructing = true;
  s.players.player.resources.ore = 10000;
  assert.equal(upgradeSpaceport(s, sp), false, "a half-built pad can't upgrade");
});

test("a jump lifts only the pad's capacity in ship-supply; the overflow waits for the next trip", () => {
  const g = createGalaxy({ seed: 41 });
  const from = settle(activeState(g));
  const sp = farSpaceport(from);
  const cap = jumpCapacity(sp);                         // Tier-1 capacity, in supply
  const total = cap + 6;
  for (let i = 0; i < total; i++) {                     // supply-1 skiffs, so unit count == supply
    const u = makeUnit("skiff", "player", sp.x + (i % 5), sp.y + (i % 3)); from.units.set(u.id, u);
  }
  const m = jumpManifest(from, sp);
  assert.equal(m.capacity, cap);
  assert.equal(m.stagedSupply, total, "every staged skiff is 1 supply");
  assert.equal(m.used, cap, "the manifest fills exactly to capacity");
  assert.equal(m.leftBehind, total - cap, "the overflow is held back");

  const destId = g.worlds.find(w => w !== g.activeId);
  g.credits = 2000;
  const res = jumpCapital(g, destId);
  assert.equal(res.riders, cap, "only capacity-worth of fleet crossed");
  assert.equal(res.leftBehind, total - cap, "the rest stayed at the origin pad");
  const dest = activeState(g);
  assert.equal([...dest.units.values()].filter(u => u.owner === "player" && u.type === "skiff").length, cap,
    "the destination received exactly the capacity");
  assert.equal([...from.units.values()].filter(u => u.owner === "player" && u.type === "skiff").length, total - cap,
    "the overflow is still at the origin, ready for a second jump");
});

test("a bigger pad lifts a bigger fleet in one jump", () => {
  const g = createGalaxy({ seed: 42 });
  const from = settle(activeState(g));
  const sp = farSpaceport(from);
  from.players.player.resources.ore = 10000;
  upgradeSpaceport(from, sp); upgradeSpaceport(from, sp);   // → Tier 3
  const cap = jumpCapacity(sp);
  for (let i = 0; i < cap; i++) {                            // exactly Tier-3 capacity in supply-1 skiffs
    const u = makeUnit("skiff", "player", sp.x + (i % 6), sp.y + (i % 4)); from.units.set(u.id, u);
  }
  const m = jumpManifest(from, sp);
  assert.equal(m.leftBehind, 0, "a Tier-3 pad lifts the whole fleet at once");
  assert.equal(m.used, cap);
});

// Regression: jumpCapital used to resolve "the" launch pad via playerSpaceport, which picked
// only the FIRST completed Spaceport found in Map iteration order — a second (or third) pad's
// staged units were silently never considered at all, on every single jump, forever. Two pads
// placed far enough apart that their JUMP_LOAD_RADIUS catchments never overlap, each with its
// own staged fleet, so this can only pass if BOTH pads' units are actually gathered.
test("a jump lifts staged units from EVERY completed Spaceport, not just the first one found", () => {
  const g = createGalaxy({ seed: 43 });
  const from = settle(activeState(g));
  const base = from.map.bases.player;
  const spA = makeBuilding("spaceport", "player", base.x + 600, base.y + 600);
  const spB = makeBuilding("spaceport", "player", base.x - 600, base.y - 600);
  from.buildings.set(spA.id, spA);
  from.buildings.set(spB.id, spB);   // inserted SECOND — exactly the pad the old .find() bug would ignore

  const staged = [];
  for (let i = 0; i < 3; i++) {
    const uA = makeUnit("skiff", "player", spA.x + i, spA.y); from.units.set(uA.id, uA); staged.push(uA);
    const uB = makeUnit("skiff", "player", spB.x + i, spB.y); from.units.set(uB.id, uB); staged.push(uB);
  }

  const destId = g.worlds.find(w => w !== g.activeId);
  g.credits = 2000;
  const res = jumpCapital(g, destId);
  assert.equal(res.riders, 6, "all 6 staged skiffs — 3 at EACH pad — cross in one jump");
  assert.equal(res.leftBehind, 0);
  const dest = activeState(g);
  assert.equal([...dest.units.values()].filter(u => u.owner === "player" && u.type === "skiff").length, 6,
    "the destination received units staged at both Spaceports, not just spA");
  assert.equal([...from.units.values()].filter(u => u.owner === "player" && u.type === "skiff").length, 0,
    "nothing from either pad was left behind at the origin");
});

test("jumpVessel finds a colony ship staged at a SECOND Spaceport, not just the first one built", () => {
  const g = createGalaxy({ seed: 44 });
  const from = settle(activeState(g));
  const base = from.map.bases.player;
  const spA = makeBuilding("spaceport", "player", base.x + 600, base.y + 600);
  const spB = makeBuilding("spaceport", "player", base.x - 600, base.y - 600);
  from.buildings.set(spA.id, spA);   // built first — nothing staged here
  from.buildings.set(spB.id, spB);   // built second — the ship is staged HERE

  assert.equal(jumpVessel(from), null, "no ship staged at either pad yet");
  const ship = makeUnit("colonyship", "player", spB.x, spB.y);
  from.units.set(ship.id, ship);
  assert.equal(jumpVessel(from)?.id, ship.id, "a ship staged at the second pad is still found");
});

/* ---------- progress milestones (fireworks, not wins) ---------- */

test("founding your first base fires the world:1 milestone (and never ends the game)", () => {
  const g = createGalaxy({ seed: 50 });
  checkGalaxyProgress(g);
  assert.ok(!g.reached.has("world:1"), "a lone colony ship hasn't founded a base yet");
  settle(activeState(g));                                 // deploy the start ship → the first CC
  checkGalaxyProgress(g);
  assert.ok(g.reached.has("world:1"), "the first Command Center founds your first colony");
  assert.ok(g.milestones.includes("world:1"), "…queued for a firework");
  assert.ok(!activeState(g).over, "a milestone never ends the game");
});

test("fortifying a Capital fires the capital milestone", () => {
  const g = createGalaxy({ seed: 51 });
  const s = settle(activeState(g));
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  s.players.player.resources.ore = 1000;
  upgradeToCapital(s, cc);
  checkGalaxyProgress(g);
  assert.ok(g.reached.has("capital"), "the Capital upgrade is celebrated");
});

test("a completed Antimatter Gate is a milestone, not a win — the galaxy runs on", () => {
  const g = createGalaxy({ seed: 53 });
  const s = settle(activeState(g));
  const gate = makeBuilding("antimatter_gate", "player", s.map.bases.player.x + 200, s.map.bases.player.y + 120);
  gate.charge = 1;
  s.buildings.set(gate.id, gate);
  checkGalaxyProgress(g);
  assert.ok(g.reached.has("gate"), "a full-charge Gate fires the gate milestone");
  assert.ok(!activeState(g).over, "…and does not end the sandbox");
  tick(s, 0.1);
  assert.ok(!s.over, "the sim's per-tick win check is suppressed for a galaxy world (play-forever)");
});

test("milestones fire once and persist across a save/load (no re-firing fireworks)", () => {
  const g = createGalaxy({ seed: 52 });
  settle(activeState(g));
  checkGalaxyProgress(g);
  assert.ok(g.reached.has("world:1"));
  g.milestones.length = 0;                                // pretend boot.js drained the firework
  checkGalaxyProgress(g);
  assert.equal(g.milestones.length, 0, "an already-reached milestone doesn't re-fire");
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.ok(restored.reached.has("world:1"), "reached milestones persist");
  checkGalaxyProgress(restored);
  assert.equal(restored.milestones.length, 0, "a reload doesn't replay the firework");
});
