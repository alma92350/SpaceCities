import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { buildUnitGrid } from "../engine/grid.js";
import { updateCombat, updateBuildingCombat, updateWorkerCombat } from "../engine/combat.js";
import { UNITS, BUILDINGS, UPGRADES, rankMults } from "../engine/entities.js";
import { sampleTerrain } from "../engine/map.js";
import { collectAnvils } from "../engine/sim.js";

function faceOff(state, x = 500, y = 500) {
  const a = makeUnit("skiff", "player", x, y);
  const b = makeUnit("skiff", "ai", x + 10, y);   // well within weapon range
  state.units.set(a.id, a);
  state.units.set(b.id, b);
  return [a, b];
}

test("a combat unit auto-acquires and damages an enemy within aggro range with no order at all", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.ok(b.hp < startHp);
});

test("focus-fire: a unit with a focusId concentrates on that target over a closer one", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const closer = makeUnit("skiff", "player", 512, 500);   // nearest — the dispersed pick might otherwise take this
  const focus = makeUnit("skiff", "player", 530, 500);    // the directed target, still inside skiff range/aggro
  for (const u of [attacker, closer, focus]) state.units.set(u.id, u);
  attacker.attackTimer = 0;
  attacker.focusId = focus.id;
  const focusHp = focus.hp, closerHp = closer.hp;

  updateCombat(state, attacker, 0);   // dt 0 so only targeting + the ready shot happen

  assert.ok(focus.hp < focusHp, "the directed (focus) target took the hit");
  assert.equal(closer.hp, closerHp, "the closer enemy was ignored in favour of the focus target");
});

test("focus-fire falls back to normal acquire when the focus target is dead or out of reach", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const near = makeUnit("skiff", "player", 515, 500);
  state.units.set(attacker.id, attacker);
  state.units.set(near.id, near);
  attacker.attackTimer = 0;
  attacker.focusId = "u-does-not-exist";   // stale focus
  const nearHp = near.hp;

  updateCombat(state, attacker, 0);

  assert.ok(near.hp < nearHp, "a stale focus doesn't freeze the unit — it auto-acquires the real enemy");
});

test("Hold stance: a holding unit fires on an in-range enemy but won't chase one out of range", () => {
  const s1 = createGameState({ planetId: "ferros" });
  const holder = makeUnit("skiff", "player", 500, 500);   // range 40, aggro 120
  const far = makeUnit("skiff", "ai", 590, 500);          // 90 away: inside aggro, outside range
  s1.units.set(holder.id, holder); s1.units.set(far.id, far);
  holder.hold = true;
  updateCombat(s1, holder, 0.1);
  assert.equal(holder.x, 500, "a holding unit stands its ground instead of chasing an out-of-range target");

  const s2 = createGameState({ planetId: "ferros" });
  const holder2 = makeUnit("skiff", "player", 500, 500);
  const near = makeUnit("skiff", "ai", 520, 500);         // 20 away: already in range
  s2.units.set(holder2.id, holder2); s2.units.set(near.id, near);
  holder2.hold = true; holder2.attackTimer = 0;
  const nearHp = near.hp;
  updateCombat(s2, holder2, 0.1);
  assert.ok(near.hp < nearHp, "but it still fires on anything that comes into range");
});

test("a combat unit's death no longer grants an instant resource refund to its owner", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const victim = makeUnit("skiff", "player", 510, 500);
  state.units.set(attacker.id, attacker); state.units.set(victim.id, victim);
  victim.hp = 1; attacker.attackTimer = 0;
  const before = state.players.player.resources.ore;

  updateCombat(state, attacker, 0);

  assert.equal(state.units.has(victim.id), false, "the victim died");
  assert.equal(state.players.player.resources.ore, before,
    "no instant refund — it leaves minable battle wreckage instead (see test/wreckage.test.js)");
});

test("a dead worker now leaves wreckage too, unlike the old combat-only salvage refund", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const worker = makeUnit("worker", "player", 510, 500);
  state.units.set(attacker.id, attacker); state.units.set(worker.id, worker);
  worker.hp = 1; attacker.attackTimer = 0;

  updateCombat(state, attacker, 0);

  assert.equal(state.units.has(worker.id), false, "the worker died");
  assert.equal(state.wrecks.length, 1, "workers now leave wreckage too — no longer a total loss (test/wreckage.test.js)");
});

test("kiting: a reloading Tactical ranged unit steps away from a closed-in enemy without firing", () => {
  const state = createGameState({ planetId: "ferros", aiMicro: true });
  const lancer = makeUnit("lancer", "ai", 500, 500);        // range 55, so danger band ~41
  const enemy = makeUnit("bastion", "player", 520, 500);    // 20 away — well inside the danger band
  state.units.set(lancer.id, lancer); state.units.set(enemy.id, enemy);
  lancer.order = { type: "attack", targetId: enemy.id };
  lancer.attackTimer = 1;   // reloading — should kite, not shoot
  const enemyHp = enemy.hp;

  updateCombat(state, lancer, 0.1);

  assert.ok(lancer.x < 500, "the lancer backed away from the enemy on its right");
  assert.equal(enemy.hp, enemyHp, "and held its fire while reloading (no shot this tick)");
});

test("T-017: kiting follows the owner's OWN controller, not a hardcoded \"ai\" literal — a micro-enabled \"player\" seat kites too", () => {
  const state = createGameState({ planetId: "ferros" });   // aiMicro affects state.ai only; irrelevant here
  state.playerAi = { micro: true };   // exactly what self-play/duel populate (test/ai-selfplay.test.js) — never true in ordinary single-player
  const lancer = makeUnit("lancer", "player", 500, 500);
  const enemy = makeUnit("bastion", "ai", 520, 500);
  state.units.set(lancer.id, lancer); state.units.set(enemy.id, enemy);
  lancer.order = { type: "attack", targetId: enemy.id };
  lancer.attackTimer = 1;

  updateCombat(state, lancer, 0.1);

  assert.ok(lancer.x < 500, "a \"player\"-owned unit whose OWN controller has micro on must kite too, exactly like \"ai\" already does");
});

test("T-017: ordinary single-player is unaffected — a \"player\" unit never kites when state.playerAi is null (the byte-identical case)", () => {
  const state = createGameState({ planetId: "ferros", aiMicro: true });   // state.ai.micro true, but that's the OTHER seat's controller
  const lancer = makeUnit("lancer", "player", 500, 500);
  const enemy = makeUnit("bastion", "ai", 520, 500);
  state.units.set(lancer.id, lancer); state.units.set(enemy.id, enemy);
  lancer.order = { type: "attack", targetId: enemy.id };
  lancer.attackTimer = 1;

  updateCombat(state, lancer, 0.1);

  assert.equal(lancer.x, 500, "state.playerAi is null in every ordinary match, so this stays exactly today's behaviour");
});

test("kiting is Tactical-only and ranged-only: a Standard ranged unit and a melee unit both hold ground", () => {
  // Standard AI (micro off): a reloading lancer stands.
  const std = createGameState({ planetId: "ferros" });
  const l1 = makeUnit("lancer", "ai", 500, 500);
  const e1 = makeUnit("bastion", "player", 520, 500);
  std.units.set(l1.id, l1); std.units.set(e1.id, e1);
  l1.order = { type: "attack", targetId: e1.id }; l1.attackTimer = 1;
  updateCombat(std, l1, 0.1);
  assert.equal(l1.x, 500, "Standard AI never kites");

  // Tactical, but a melee brawler (range < 50) doesn't kite either.
  const tac = createGameState({ planetId: "ferros", aiMicro: true });
  const b1 = makeUnit("bastion", "ai", 500, 500);   // range 24 — too short to kite
  const e2 = makeUnit("skiff", "player", 512, 500);
  tac.units.set(b1.id, b1); tac.units.set(e2.id, e2);
  b1.order = { type: "attack", targetId: e2.id }; b1.attackTimer = 1;
  updateCombat(tac, b1, 0.1);
  assert.equal(b1.x, 500, "a short-range brawler stands and trades, it doesn't kite");
});

test("a killed target is removed from state and the killer's explicit order clears", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  a.order = { type: "attack", targetId: b.id };
  b.hp = 1;   // one hit from behind the guard clause below

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(state.units.has(b.id), false);
  assert.equal(a.order, null);
});

test("an explicit attack order on a target killed by someone else re-acquires instead of freezing", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  const c = makeUnit("skiff", "player", 500, 500);
  state.units.set(c.id, c);

  a.order = { type: "attack", targetId: b.id };
  state.units.delete(b.id);   // simulate b dying to a different attacker this same tick

  const other = makeUnit("skiff", "ai", a.x + 10, a.y);
  state.units.set(other.id, other);
  const startHp = other.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(a.order, null, "the stale order should be dropped, not kept forever");
  assert.ok(other.hp < startHp, "it should have engaged the new nearby enemy instead of idling");
});

test("T-019: an explicit attack order naming a FRIENDLY unit is rejected — no friendly fire", () => {
  const state = createGameState({ planetId: "ferros" });
  const a = makeUnit("skiff", "player", 500, 500);
  const friendly = makeUnit("skiff", "player", 508, 500);   // same owner, well within range
  state.units.set(a.id, a);
  state.units.set(friendly.id, friendly);
  a.order = { type: "attack", targetId: friendly.id };
  const friendlyHp = friendly.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(friendly.hp, friendlyHp, "a same-owner target must never take damage from an explicit attack order");
  assert.equal(a.order, null, "the friendly-fire order must be cleared, not left standing");
});

test("T-019: a worker's explicit attack order naming a FRIENDLY unit is rejected too", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const friendly = makeUnit("skiff", "player", 508, 500);
  state.units.set(worker.id, worker);
  state.units.set(friendly.id, friendly);
  worker.order = { type: "attack", targetId: friendly.id };
  const friendlyHp = friendly.hp;

  updateWorkerCombat(state, worker, UNITS.worker, UNITS.worker.cooldown);

  assert.equal(friendly.hp, friendlyHp, "a same-owner target must never take a worker's hit either");
  assert.equal(worker.order, null, "the friendly-fire order must be cleared for a worker too");
});

test("a plain move order is honored even with an enemy sitting right on top of the destination", () => {
  const state = createGameState({ planetId: "ferros" });
  const a = makeUnit("skiff", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 505, 500);   // well within aggro range
  state.units.set(a.id, a);
  state.units.set(enemy.id, enemy);
  a.order = { type: "move", x: 700, y: 500 };
  const enemyHp = enemy.hp;

  updateCombat(state, a, 0.1);

  assert.equal(enemy.hp, enemyHp, "should not have attacked despite the enemy being in range");
  assert.ok(a.x > 500, "should have moved toward its destination, not stayed to fight");
  assert.equal(a.order.type, "move", "the move order should survive an enemy being nearby");
});

test("a worker lands its (weak) hit on an enemy it's been ordered to attack", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 508, 500);   // within the worker's short reach
  state.units.set(worker.id, worker);
  state.units.set(enemy.id, enemy);
  worker.order = { type: "attack", targetId: enemy.id };
  const startHp = enemy.hp;

  updateWorkerCombat(state, worker, UNITS.worker, UNITS.worker.cooldown);

  assert.equal(startHp - enemy.hp, UNITS.worker.attack, "a worker's swing lands for its attack stat");
});

test("a worker's kill clears its attack order so a queued waypoint (or idle) can follow", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 508, 500);
  state.units.set(worker.id, worker);
  state.units.set(enemy.id, enemy);
  worker.order = { type: "attack", targetId: enemy.id };
  enemy.hp = 1;

  updateWorkerCombat(state, worker, UNITS.worker, UNITS.worker.cooldown);

  assert.equal(state.units.has(enemy.id), false, "the target is removed");
  assert.equal(worker.order, null, "and the order clears");
});

test("a worker out of reach closes on its attack target instead of firing", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 700, 500);   // far beyond the worker's range
  state.units.set(worker.id, worker);
  state.units.set(enemy.id, enemy);
  worker.order = { type: "attack", targetId: enemy.id };
  const startHp = enemy.hp;

  updateWorkerCombat(state, worker, UNITS.worker, 0.1);

  assert.equal(enemy.hp, startHp, "no damage from out of range");
  assert.ok(worker.x > 500, "it moved toward the target");
});

test("a move order still eventually clears on arrival, same as before", () => {
  const state = createGameState({ planetId: "ferros" });
  const a = makeUnit("skiff", "player", 500, 500);
  state.units.set(a.id, a);
  a.order = { type: "move", x: 500, y: 500 };   // already there

  updateCombat(state, a, 0.1);

  assert.equal(a.order, null);
});

test("attack-move still engages an enemy encountered along the way (unlike plain move)", () => {
  const state = createGameState({ planetId: "ferros" });
  const a = makeUnit("skiff", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 505, 500);
  state.units.set(a.id, a);
  state.units.set(enemy.id, enemy);
  a.order = { type: "attack-move", x: 700, y: 500 };
  const enemyHp = enemy.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.ok(enemy.hp < enemyHp, "attack-move should still fight what it runs into");
});

// A patrol leg (engine/commands.js issuePatrol) is an ordinary attack-move order with an extra
// `patrol: true` flag combat.js never has to look at — the proposal's own claim ("combat.js
// needs nothing") is exactly that the flag is inert here: engaging along the way works
// identically with or without it.
test("an attack-move order carrying patrol:true still engages an enemy encountered along the way", () => {
  const state = createGameState({ planetId: "ferros" });
  const a = makeUnit("skiff", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 505, 500);
  state.units.set(a.id, a);
  state.units.set(enemy.id, enemy);
  a.order = { type: "attack-move", x: 700, y: 500, patrol: true };
  const enemyHp = enemy.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.ok(enemy.hp < enemyHp, "a patrol leg still fights what it runs into, exactly like a plain attack-move");
});

test("Bastion deals its bonus damage specifically against Skiff", () => {
  const state = createGameState({ planetId: "ferros" });
  const bastion = makeUnit("bastion", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 500 + UNITS.bastion.range - 1, 500);   // within melee range
  state.units.set(bastion.id, bastion);
  state.units.set(skiff.id, skiff);
  const startHp = skiff.hp;

  updateCombat(state, bastion, UNITS.bastion.cooldown);

  const expectedDamage = UNITS.bastion.attack + UNITS.bastion.bonusVs.skiff;
  assert.equal(startHp - skiff.hp, expectedDamage);
});

test("Bastion deals only its base damage against a non-Skiff target", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("bastion", "player", 500, 500);
  const otherBastion = makeUnit("bastion", "ai", 500 + UNITS.bastion.range - 1, 500);
  state.units.set(attacker.id, attacker);
  state.units.set(otherBastion.id, otherBastion);
  const startHp = otherBastion.hp;

  updateCombat(state, attacker, UNITS.bastion.cooldown);

  assert.equal(startHp - otherBastion.hp, UNITS.bastion.attack);
});

test("Lancer deals its bonus damage specifically against Bastion", () => {
  const state = createGameState({ planetId: "ferros" });
  const lancer = makeUnit("lancer", "player", 500, 500);
  const bastion = makeUnit("bastion", "ai", 500 + UNITS.lancer.range - 1, 500);   // within Lancer's long range
  state.units.set(lancer.id, lancer);
  state.units.set(bastion.id, bastion);
  const startHp = bastion.hp;

  updateCombat(state, lancer, UNITS.lancer.cooldown);

  const expectedDamage = UNITS.lancer.attack + UNITS.lancer.bonusVs.bastion;
  assert.equal(startHp - bastion.hp, expectedDamage);
});

test("Lancer deals only its base damage against a non-Bastion target", () => {
  const state = createGameState({ planetId: "ferros" });
  const lancer = makeUnit("lancer", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 500 + UNITS.lancer.range - 1, 500);
  state.units.set(lancer.id, lancer);
  state.units.set(skiff.id, skiff);
  const startHp = skiff.hp;

  updateCombat(state, lancer, UNITS.lancer.cooldown);

  assert.equal(startHp - skiff.hp, UNITS.lancer.attack);
});

test("Skiff deals its bonus damage specifically against Lancer, closing the rock-paper-scissors loop", () => {
  const state = createGameState({ planetId: "ferros" });
  const skiff = makeUnit("skiff", "player", 500, 500);
  const lancer = makeUnit("lancer", "ai", 500 + UNITS.skiff.range - 1, 500);
  state.units.set(skiff.id, skiff);
  state.units.set(lancer.id, lancer);
  const startHp = lancer.hp;

  updateCombat(state, skiff, UNITS.skiff.cooldown);

  const expectedDamage = UNITS.skiff.attack + UNITS.skiff.bonusVs.lancer;
  assert.equal(startHp - lancer.hp, expectedDamage);
});

test("the rock-paper-scissors triangle is a genuine cycle: no unit also counters the unit that counters it", () => {
  assert.ok(UNITS.skiff.bonusVs.lancer > 0, "Skiff should beat Lancer");
  assert.ok(UNITS.bastion.bonusVs.skiff > 0, "Bastion should beat Skiff");
  assert.ok(UNITS.lancer.bonusVs.bastion > 0, "Lancer should beat Bastion");
  assert.ok(!UNITS.skiff.bonusVs.bastion, "Skiff must not also counter Bastion, or Skiff would beat everything");
  assert.ok(!UNITS.bastion.bonusVs.lancer, "Bastion must not also counter Lancer, or Bastion would beat everything");
  assert.ok(!UNITS.lancer.bonusVs.skiff, "Lancer must not also counter Skiff, or Lancer would beat everything");
});

// Counter-triangle readability (docs/improvement-proposals.md "Counter-triangle telegraphs"):
// performAttack stamps a `bonus` flag on the attackHit event whenever bonusVs applied, so
// effects.js/renderEffects.js can telegraph a counter hit instead of drawing it identically to
// a futile plink. Pure event bookkeeping — the damage-amount assertions above already cover the
// numbers; these only check the new event field.
test("performAttack stamps bonus:true on the attackHit event when the attacker's bonusVs counters the target's type", () => {
  const state = createGameState({ planetId: "ferros" });
  const skiff = makeUnit("skiff", "ai", 500, 500);   // Skiff.bonusVs = { lancer: 10 }
  const lancer = makeUnit("lancer", "player", 500 + UNITS.skiff.range - 1, 500);
  state.units.set(skiff.id, skiff);
  state.units.set(lancer.id, lancer);

  updateCombat(state, skiff, UNITS.skiff.cooldown);

  const hit = state.events.find(e => e.type === "attackHit");
  assert.ok(hit, "expected an attackHit event");
  assert.equal(hit.bonus, true, "Skiff vs Lancer is the counter-triangle bonus matchup");
});

test("performAttack leaves the attackHit event's bonus flag falsy for a matchup with no bonusVs", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);   // two Skiffs — neither counters the other

  updateCombat(state, a, UNITS.skiff.cooldown);

  const hit = state.events.find(e => e.type === "attackHit");
  assert.ok(hit, "expected an attackHit event");
  assert.ok(!hit.bonus, "no counter-triangle bonus applies between two Skiffs");
});

// The `bonus` flag is scoped to the per-type hard counter (def.bonusVs[target.type]) only — kept
// distinct from the pre-existing `heavy` flag (def.bonusVsBuildings, a class-wide siege bonus with
// no specific counter-triangle matchup to telegraph). A Breacher has no bonusVs table at all, so
// its building hits stay `heavy` but never `bonus`.
test("performAttack's bonus flag stays falsy for a class-wide siege bonus (bonusVsBuildings), unlike the pre-existing heavy flag", () => {
  const state = createGameState({ planetId: "ferros" });
  const breacher = makeUnit("breacher", "player", 500, 500);   // bonusVsBuildings: 30, no per-type bonusVs
  const turret = makeBuilding("turret", "ai", 500 + UNITS.breacher.range - 1, 500);
  state.units.set(breacher.id, breacher);
  state.buildings.set(turret.id, turret);
  breacher.order = { type: "attack", targetId: turret.id };

  updateCombat(state, breacher, UNITS.breacher.cooldown);

  const hit = state.events.find(e => e.type === "attackHit");
  assert.ok(hit, "expected an attackHit event");
  assert.equal(hit.heavy, true, "sanity: this is the same siege hit the pre-existing `heavy` flag already covers");
  assert.ok(!hit.bonus, "bonusVsBuildings is not a bonusVs counter-triangle matchup, so bonus must stay falsy");
});

test("Skiff has no bonus damage table and deals only its base attack", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(startHp - b.hp, UNITS.skiff.attack);
});

test("Overcharged Weapons multiplies the attacker's damage dealt", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.player.upgrades.overchargedWeapons = true;
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const { damageDealtMult } = UPGRADES.overchargedWeapons;
  assert.ok(Math.abs((startHp - b.hp) - UNITS.skiff.attack * damageDealtMult) < 1e-9);
});

test("Reinforced Plating multiplies the defender's damage taken", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.ai.upgrades.reinforcedPlating = true;   // the defender's research, not the attacker's
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const { damageTakenMult } = UPGRADES.reinforcedPlating;
  assert.ok(Math.abs((startHp - b.hp) - UNITS.skiff.attack * damageTakenMult) < 1e-9);
});

// Bulwark's structure shielding, made official (docs/improvement-proposals.md): attackDamage
// (engine/combat.js) applies damageTakenMult to EVERY target it computes damage for — units AND
// buildings alike, with no kind/role filter — so a Bulwark player's turrets, Command Center, and
// Habitats already take reduced damage too, not just their combat units. These two pin that
// already-live behavior against the two structures the proposal calls out by name: a turret (the
// static defense a raid has to punch through) and a Habitat (hp 250, the softest raid target).
test("Reinforced Plating reduces damage taken by a defended turret, not just combat units", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const turret = makeBuilding("turret", "ai", 510, 500);   // same stand-off faceOff uses for its unit-target sibling above
  state.units.set(attacker.id, attacker);
  state.buildings.set(turret.id, turret);
  state.players.ai.upgrades.reinforcedPlating = true;   // the turret owner's research, not the attacker's
  const startHp = turret.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  const { damageTakenMult } = UPGRADES.reinforcedPlating;
  assert.ok(Math.abs((startHp - turret.hp) - UNITS.skiff.attack * damageTakenMult) < 1e-9,
    "a Bulwark-researched turret takes reduced damage exactly like a combat unit would");
});

test("Reinforced Plating reduces damage taken by a defended Habitat, the softest raid target", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const habitat = makeBuilding("habitat", "ai", 510, 500);
  state.units.set(attacker.id, attacker);
  state.buildings.set(habitat.id, habitat);
  state.players.ai.upgrades.reinforcedPlating = true;
  const startHp = habitat.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  const { damageTakenMult } = UPGRADES.reinforcedPlating;
  assert.ok(Math.abs((startHp - habitat.hp) - UNITS.skiff.attack * damageTakenMult) < 1e-9,
    "a Habitat (hp 250) — the raid target supply chokes on — is shielded by Bulwark too");
});

test("both upgrades stack: attacker's damage bonus and defender's damage reduction apply together", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.player.upgrades.overchargedWeapons = true;
  state.players.ai.upgrades.reinforcedPlating = true;
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const expected = UNITS.skiff.attack * UPGRADES.overchargedWeapons.damageDealtMult * UPGRADES.reinforcedPlating.damageTakenMult;
  assert.ok(Math.abs((startHp - b.hp) - expected) < 1e-9);
});

test("attackers fan out across several nearby enemies instead of all dogpiling the nearest", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear();
  // A cluster of attackers facing a cluster of enemies, all within the local
  // engagement band — so the spread policy has several targets to distribute
  // across rather than everyone locking the single closest.
  const attackers = [];
  for (let i = 0; i < 6; i++) { const u = makeUnit("skiff", "player", 500 + i * 4, 500); state.units.set(u.id, u); attackers.push(u); }
  for (let i = 0; i < 4; i++) { const e = makeUnit("skiff", "ai", 545 + i * 8, 500); state.units.set(e.id, e); }

  for (const u of attackers) updateCombat(state, u, 0.001);   // acquire (tiny dt so nobody dies this step)

  const targets = new Set(attackers.map(u => u.autoTarget).filter(Boolean));
  assert.ok(targets.size >= 2, `attackers should spread across multiple targets, got ${targets.size}`);
});

test("a unit sticks to its auto-target while it's alive and in range, instead of re-picking each tick", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear();
  const a = makeUnit("skiff", "player", 500, 500);
  const near = makeUnit("skiff", "ai", 520, 500);
  const nearer = makeUnit("skiff", "ai", 505, 500);   // closer, but arrives "after" a is already locked on `near`
  state.units.set(a.id, a);
  state.units.set(near.id, near);
  a.autoTarget = near.id;                              // already committed
  updateCombat(state, a, 0.001);
  assert.equal(a.autoTarget, near.id, "it keeps its committed target even with a closer enemy present");
  state.units.set(nearer.id, nearer);                 // introduce the closer enemy AFTER the lock
  updateCombat(state, a, 0.001);
  assert.equal(a.autoTarget, near.id, "still committed — no re-dogpiling onto the newly-closest foe");
});

test("the two Assault tiers stack multiplicatively on damage dealt", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.player.upgrades.overchargedWeapons = true;   // Assault I
  state.players.player.upgrades.overchargedCore = true;      // Assault II
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const mult = UPGRADES.overchargedWeapons.damageDealtMult * UPGRADES.overchargedCore.damageDealtMult;
  assert.ok(Math.abs((startHp - b.hp) - UNITS.skiff.attack * mult) < 1e-9, "both tiers multiply the base damage");
});

// ---- Doctrine depth redesign (docs/improvement-proposals.md, merged): Assault's Tier-2 grants a
// chase-speed verb and its Tier-3 capstone (Overdrive Actuators) grants attack tempo — two
// mechanically distinct identities, unlike Bulwark's regen (see test/repair.test.js for that
// reconciliation). lastHitAt stamping (read by Bulwark's regen pass) is also pinned here since
// it's stamped from this file's performAttack/applySplash.

test("Overcharged Core (Assault Tier 2) grants chaseSpeedMult: a unit chasing an acquired-but-out-of-range target closes distance faster", () => {
  const dt = 0.05;
  function chaseStep(withUpgrade) {
    const state = createGameState({ planetId: "ferros" });
    const chaser = makeUnit("skiff", "player", 500, 500);
    const target = makeUnit("skiff", "ai", 580, 500);   // 80 away: beyond range (40), inside aggro (120)
    state.units.set(chaser.id, chaser);
    state.units.set(target.id, target);
    chaser.autoTarget = target.id;   // already acquired — isolate the chase branch from acquisition
    if (withUpgrade) state.players.player.upgrades.overchargedCore = true;
    updateCombat(state, chaser, dt);
    return chaser.x - 500;
  }

  const plain = chaseStep(false);
  const boosted = chaseStep(true);
  assert.ok(plain > 0, "sanity: the unit actually closed distance this tick");
  const { chaseSpeedMult } = UPGRADES.overchargedCore;
  assert.ok(Math.abs(boosted - plain * chaseSpeedMult) < 1e-9,
    `expected the chase step scaled by chaseSpeedMult (${chaseSpeedMult}), got ${boosted} vs plain ${plain}`);
});

test("chaseSpeedMult only speeds up the chase branch, not a plain move order", () => {
  const state = createGameState({ planetId: "ferros" });
  const unit = makeUnit("skiff", "player", 500, 500);
  state.units.set(unit.id, unit);
  state.players.player.upgrades.overchargedCore = true;
  unit.order = { type: "move", x: 600, y: 500 };

  updateCombat(state, unit, 0.05);

  assert.ok(Math.abs((unit.x - 500) - UNITS.skiff.speed * 0.05) < 1e-9,
    "a plain move order travels at the unit's ordinary speed — chaseSpeedMult never applies here");
});

test("Overdrive Actuators (Assault Tier 3) shortens the attack cooldown reset — the main unit attack path", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  a.attackTimer = 0;
  state.players.player.upgrades.overdriveActuators = true;

  updateCombat(state, a, 0);

  const { attackCooldownMult } = UPGRADES.overdriveActuators;
  assert.ok(Math.abs(a.attackTimer - UNITS.skiff.cooldown * attackCooldownMult) < 1e-9,
    "the reset cooldown is multiplied by attackCooldownMult");
});

test("without Overdrive Actuators, the attack cooldown resets to the unit's plain cooldown", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  a.attackTimer = 0;

  updateCombat(state, a, 0);

  assert.equal(a.attackTimer, UNITS.skiff.cooldown, "no capstone researched -> unmultiplied cooldown");
});

test("Overdrive Actuators also shortens the attack cooldown reset for a worker's explicit attack order", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 505, 500);   // 5 away, inside the worker's 15 range
  state.units.set(worker.id, worker);
  state.units.set(target.id, target);
  worker.order = { type: "attack", targetId: target.id };
  worker.attackTimer = 0;
  state.players.player.upgrades.overdriveActuators = true;

  updateWorkerCombat(state, worker, UNITS.worker, 0);

  const { attackCooldownMult } = UPGRADES.overdriveActuators;
  assert.ok(Math.abs(worker.attackTimer - UNITS.worker.cooldown * attackCooldownMult) < 1e-9);
});

test("Overdrive Actuators does not speed up static defense — a turret's cooldown is untouched (army tempo, not base defense)", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const turret = makeBuilding("turret", "player", 510, 500);
  state.units.set(attacker.id, attacker);
  state.buildings.set(turret.id, turret);
  state.players.player.upgrades.overdriveActuators = true;   // the turret owner's research
  turret.attackTimer = 0;

  updateBuildingCombat(state, turret, 0);

  assert.equal(turret.attackTimer, BUILDINGS.turret.cooldown,
    "the Assault capstone is scoped to mobile army units — a turret's fire rate is unaffected");
});

test("a landed hit stamps the target's lastHitAt to the current state.time", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.time = 123.5;
  assert.equal(b.lastHitAt, undefined, "sanity: never hit yet");

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(b.lastHitAt, 123.5, "the moment damage lands, the target's lastHitAt is stamped to state.time");
});

test("splash damage also stamps lastHitAt on the units it catches, not just the primary target", () => {
  const state = createGameState({ planetId: "ferros" });
  state.time = 77;
  const colossus = makeUnit("colossus", "player", 500, 500);
  const primary = makeUnit("skiff", "ai", 600, 500);     // within Colossus range (185)
  const bystander = makeUnit("skiff", "ai", 610, 500);   // 10 away from primary — inside splash radius (26)
  state.units.set(colossus.id, colossus);
  state.units.set(primary.id, primary);
  state.units.set(bystander.id, bystander);
  colossus.attackTimer = 0;
  colossus.autoTarget = primary.id;   // isolate splash from acquisition

  updateCombat(state, colossus, 0);

  assert.equal(primary.lastHitAt, 77, "the primary target is stamped");
  assert.equal(bystander.lastHitAt, 77, "a bystander caught in the splash radius is stamped too");
});

test("a player's own upgrades don't affect damage against their own side", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.player.upgrades.reinforcedPlating = true;   // attacker researched the DEFENSIVE upgrade for themselves
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(startHp - b.hp, UNITS.skiff.attack, "the attacker's own defensive research shouldn't reduce their own damage output");
});

// A completed turret standing at (500,500); enemies dropped near it, well
// clear of the map's far-apart Command Centers so the only target in aggro
// is the one the test placed.
function turretAt(state, x = 500, y = 500) {
  const t = makeBuilding("turret", "player", x, y);
  state.buildings.set(t.id, t);
  return t;
}

test("a completed Sentinel Turret auto-acquires and damages an enemy unit in range", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", turret.x + 10, turret.y);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(startHp - enemy.hp, BUILDINGS.turret.attack);
  assert.equal(turret.targetId, enemy.id);
});

test("a turret's target that dies to someone else earlier the same tick is dropped, not deref'd — it re-acquires cleanly instead of freezing", () => {
  // The mobile-unit analog: "an explicit attack order on a target killed by someone else
  // re-acquires instead of freezing" above. A turret has no order pipeline, but building.targetId
  // is the same kind of persisted, potentially-stale reference — this simulates it having locked
  // onto `stale` on some earlier pass, then `stale` dying to a DIFFERENT attacker before the
  // turret's own updateBuildingCombat runs this tick.
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const stale = makeUnit("skiff", "ai", turret.x + 10, turret.y);
  state.units.set(stale.id, stale);
  turret.targetId = stale.id;          // simulate the turret already locked onto this target
  state.units.delete(stale.id);        // simulate it dying to a different attacker earlier this same tick

  const other = makeUnit("skiff", "ai", turret.x + 15, turret.y);   // a fresh live enemy still in range
  state.units.set(other.id, other);
  const startHp = other.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(turret.targetId, other.id, "re-acquired the live enemy instead of keeping/deref'ing the dead one");
  assert.ok(other.hp < startHp, "and actually landed a hit on it, same tick");
  assert.ok(Number.isFinite(other.hp), "no NaN-poisoning from a stale dereferenced target");
});

test("a turret whose only target dies to someone else earlier the same tick goes idle, not stuck referencing the corpse", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const stale = makeUnit("skiff", "ai", turret.x + 10, turret.y);
  state.units.set(stale.id, stale);
  turret.targetId = stale.id;
  state.units.delete(stale.id);   // dies to someone else, and nothing else is left in range

  assert.doesNotThrow(() => updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown));
  assert.equal(turret.targetId, null, "cleanly falls back to idle rather than holding the stale id");
});

test("a turret under construction never fires and holds no target", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = makeBuilding("turret", "player", 500, 500, { constructing: true });
  state.buildings.set(turret.id, turret);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(enemy.hp, startHp, "an unfinished turret must not deal damage");
  assert.equal(turret.targetId, null);
});

test("a turret ignores an enemy sitting just beyond its range", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", turret.x + BUILDINGS.turret.range + 5, turret.y);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(enemy.hp, startHp);
  assert.equal(turret.targetId, null);
});

test("a turret respects its cooldown: two quick ticks land only one hit", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, 0.1);
  updateBuildingCombat(state, turret, 0.1);   // still inside cooldown — no second shot

  assert.equal(startHp - enemy.hp, BUILDINGS.turret.attack);
});

test("a turret kill removes the entity and pushes an entityKilled event", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  enemy.hp = 1;
  state.units.set(enemy.id, enemy);

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(state.units.has(enemy.id), false);
  assert.ok(state.events.some(e => e.type === "entityKilled"));
});

test("Overcharged Weapons multiplies a turret's damage, same as a unit's", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  state.units.set(enemy.id, enemy);
  state.players.player.upgrades.overchargedWeapons = true;
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  const { damageDealtMult } = UPGRADES.overchargedWeapons;
  assert.ok(Math.abs((startHp - enemy.hp) - BUILDINGS.turret.attack * damageDealtMult) < 1e-9);
});

test("a Breacher deals its structure bonus against a building but only base damage against a unit", () => {
  const vsBuilding = createGameState({ planetId: "ferros" });
  const breacher = makeUnit("breacher", "player", 500, 500);
  const barracks = makeBuilding("barracks", "ai", 600, 500);   // within the Breacher's 150 range
  vsBuilding.units.set(breacher.id, breacher);
  vsBuilding.buildings.set(barracks.id, barracks);
  const barracksHp = barracks.hp;

  updateCombat(vsBuilding, breacher, UNITS.breacher.cooldown);

  assert.equal(barracksHp - barracks.hp, UNITS.breacher.attack + UNITS.breacher.bonusVsBuildings);

  const vsUnit = createGameState({ planetId: "ferros" });
  const breacher2 = makeUnit("breacher", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 600, 500);
  vsUnit.units.set(breacher2.id, breacher2);
  vsUnit.units.set(skiff.id, skiff);
  const skiffHp = skiff.hp;

  updateCombat(vsUnit, breacher2, UNITS.breacher.cooldown);

  assert.equal(skiffHp - skiff.hp, UNITS.breacher.attack, "no structure bonus, no bonusVs — just base attack against a unit");
});

test("a Breacher shells a building even when an enemy unit stands closer", () => {
  const state = createGameState({ planetId: "ferros" });
  const breacher = makeUnit("breacher", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 520, 500);        // closer (20 away)
  const barracks = makeBuilding("barracks", "ai", 600, 500);   // farther (100 away)
  state.units.set(breacher.id, breacher);
  state.units.set(skiff.id, skiff);
  state.buildings.set(barracks.id, barracks);
  const skiffHp = skiff.hp, barracksHp = barracks.hp;

  updateCombat(state, breacher, UNITS.breacher.cooldown);

  assert.ok(barracks.hp < barracksHp, "prefersBuildings should win over the nearer unit");
  assert.equal(skiff.hp, skiffHp, "the closer unit should be ignored");
});

test("a Breacher falls back to the nearest unit when no building is in aggro range", () => {
  const state = createGameState({ planetId: "ferros" });
  const breacher = makeUnit("breacher", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 520, 500);
  state.units.set(breacher.id, breacher);
  state.units.set(skiff.id, skiff);
  const skiffHp = skiff.hp;

  updateCombat(state, breacher, UNITS.breacher.cooldown);

  assert.ok(skiff.hp < skiffHp, "with no building to shell, it should still engage a unit");
});

test("default acquisition is unchanged: the nearest enemy wins across units and buildings, ties to units", () => {
  const nearest = createGameState({ planetId: "ferros" });
  const skiff = makeUnit("skiff", "player", 500, 500);
  const enemyUnit = makeUnit("skiff", "ai", 530, 500);        // 30 away
  const enemyBuilding = makeBuilding("barracks", "ai", 550, 500);   // 50 away
  nearest.units.set(skiff.id, skiff);
  nearest.units.set(enemyUnit.id, enemyUnit);
  nearest.buildings.set(enemyBuilding.id, enemyBuilding);
  const unitHp = enemyUnit.hp, buildingHp = enemyBuilding.hp;

  updateCombat(nearest, skiff, UNITS.skiff.cooldown);

  assert.ok(enemyUnit.hp < unitHp, "the nearer unit should be chosen over the farther building");
  assert.equal(enemyBuilding.hp, buildingHp);

  // Exact tie: a unit and a building at the same distance both inside weapon
  // range — the unit must win (units are scanned first).
  const tie = createGameState({ planetId: "ferros" });
  const skiff2 = makeUnit("skiff", "player", 500, 500);
  const tiedUnit = makeUnit("skiff", "ai", 515, 500);
  const tiedBuilding = makeBuilding("barracks", "ai", 515, 500);
  tie.units.set(skiff2.id, skiff2);
  tie.units.set(tiedUnit.id, tiedUnit);
  tie.buildings.set(tiedBuilding.id, tiedBuilding);
  const tiedUnitHp = tiedUnit.hp, tiedBuildingHp = tiedBuilding.hp;

  updateCombat(tie, skiff2, UNITS.skiff.cooldown);

  assert.ok(tiedUnit.hp < tiedUnitHp, "an exact distance tie should resolve to the unit");
  assert.equal(tiedBuilding.hp, tiedBuildingHp);
});

test("a planet sight modifier scales aggro range for both sides", () => {
  // An enemy just inside a Skiff's full aggro range but well beyond weapon
  // range: with the target acquired the Skiff steps toward it (moving), and
  // with it out of aggro the Skiff has nothing to chase (stays put). Movement
  // is the clean tell for whether acquisition happened.
  function engages(sightMult) {
    const state = createGameState({ planetId: "ferros" });
    state.map.modifiers = { sightMult };
    const a = makeUnit("skiff", "player", 500, 500);
    const enemy = makeUnit("skiff", "ai", 500 + UNITS.skiff.aggroRange * 0.9, 500);
    state.units.set(a.id, a);
    state.units.set(enemy.id, enemy);
    updateCombat(state, a, 0.1);
    return a.x > 500;
  }

  assert.equal(engages(1), true, "at full aggro the enemy just inside range is chased");
  assert.equal(engages(0.75), false, "a 0.75 sight modifier pulls that same enemy out of aggro range");
});

test("a Breacher out-ranges a Sentinel Turret: it chips the turret down while taking nothing back", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = makeBuilding("turret", "ai", 500, 500);
  const breacher = makeUnit("breacher", "player", 500 + 140, 500);   // 140: inside Breacher's 150, outside turret's 130
  state.buildings.set(turret.id, turret);
  state.units.set(breacher.id, breacher);
  const turretHp = turret.hp, breacherHp = breacher.hp;

  for (let t = 0; t < 6; t += 0.5) {
    updateCombat(state, breacher, 0.5);
    updateBuildingCombat(state, turret, 0.5);
  }

  assert.ok(turret.hp < turretHp, "the Breacher should be steadily shelling the turret");
  assert.equal(breacher.hp, breacherHp, "the turret can't reach the Breacher, so it takes no damage");
});

// ---- Broad-phase grid: every test above drives acquireTarget through the O(n)
// fallback (no state.unitGrid at all). Real gameplay never does that — sim.js
// builds state.unitGrid every tick before combat runs — so acquireTarget's grid
// branch (queryNeighbors, engine/grid.js) needs its own coverage too.

test("acquireTarget finds an enemy through the populated broad-phase grid, across a cell boundary — not just when both units share one cell", () => {
  // engine/grid.js's CELL is 96: placing the pair 90 apart straddles the
  // column-10/11 boundary, so a broken or silently-skipped neighbor-cell query
  // (unlike the same-cell placements every other test in this file happens to
  // use) would miss this target while the O(n) fallback still finds it fine.
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 1000, 500);   // grid column 10
  const target = makeUnit("skiff", "ai", 1090, 500);         // grid column 11 — 90 away: inside aggro (120), outside weapon range (40)
  state.units.set(attacker.id, attacker);
  state.units.set(target.id, target);
  state.unitGrid = buildUnitGrid(state);   // the real per-tick broad-phase index (engine/grid.js), same as sim.js builds every tick

  updateCombat(state, attacker, 0.1);

  assert.equal(attacker.autoTarget, target.id, "the target should be acquired through the grid, same as the fallback tests above establish");
  assert.ok(attacker.x > 1000, "and immediately start closing the distance, exactly like the no-grid case");
});

// ---- Terrain's combatMult: test/terrain.test.js only checks it as static
// TERRAIN table data. Nothing before this exercised it in a live attack.

test("terrain's combatMult is genuinely applied to a live attack, not just read as static data", () => {
  // Baseline: ferros carries no terrain (test/terrain.test.js) — every cell
  // samples combatMult 1, so this is exactly the plain-base-damage case every
  // other exact-damage test in this file already assumes.
  const flat = createGameState({ planetId: "ferros" });
  const [flatAttacker, flatTarget] = faceOff(flat, 500, 500);
  const flatStartHp = flatTarget.hp;
  updateCombat(flat, flatAttacker, UNITS.skiff.cooldown);
  const flatDamage = flatStartHp - flatTarget.hp;
  assert.equal(flatDamage, UNITS.skiff.attack, "fixture sanity: flat ground deals plain base damage");

  // Pyralis' central mesa is high ground (test/terrain.test.js): the attacker
  // stands ON it, the target just beside it — combatMult is read from the
  // ATTACKER's own position (engine/combat.js attackDamage), a positional edge
  // for whoever holds the high ground, not a per-target check.
  const high = createGameState({ planetId: "pyralis" });
  const map = high.map;
  const attacker = makeUnit("skiff", "player", map.width * 0.5, map.height * 0.5);
  const target = makeUnit("skiff", "ai", map.width * 0.5 + 10, map.height * 0.5);
  high.units.set(attacker.id, attacker);
  high.units.set(target.id, target);
  const tile = sampleTerrain(map.terrain, attacker.x, attacker.y);
  assert.equal(tile.name, "high", "fixture sanity: the attacker is standing on the mesa");
  const highStartHp = target.hp;

  updateCombat(high, attacker, UNITS.skiff.cooldown);

  const highDamage = highStartHp - target.hp;
  const expected = UNITS.skiff.attack * tile.combatMult;   // documented as 1.15 (engine/map.js TERRAIN.high)
  assert.ok(Math.abs(highDamage - expected) < 1e-9, `expected exactly ${expected} from the high-ground multiplier, got ${highDamage}`);
  assert.ok(highDamage > flatDamage, "and that's strictly more than the flat-ground baseline");
});

// ---- High ground extends weapon acquisition, not just fog sight: fog reveal already
// scales by the source tile's terrain sightMult (engine/fog.js updateFog srcMult), but
// aggro (acquireTarget/stillEngageable) only ever multiplied by the sideMod sightMult,
// never terrain — so a unit on a mesa/ridge could SEE an enemy it refused to ENGAGE.
// Nothing before this exercised aggro range against terrain at all.

test("a unit on high ground acquires a fresh target beyond its flat-ground aggro range; the same distance on open ground does not", () => {
  // helix's central ridge is high ground (engine/map.js PLANET_MODIFIERS.helix) with NO
  // world-level sightMult of its own (unlike pyralis/nimbus above), so the only aggro
  // multiplier in play is the terrain one — isolates this fix from the pre-existing
  // sideMod(sightMult) path this file's other tests already cover.
  // Skiff aggroRange 120 * TERRAIN.high.sightMult 1.25 = 150.
  const D = 135;   // strictly beyond flat aggro (120), strictly inside high-ground aggro (150)

  const flat = createGameState({ planetId: "ferros" });   // no terrain at all -> sightMult/combatMult both 1 everywhere
  const flatAttacker = makeUnit("skiff", "player", 500, 500);
  const flatTarget = makeUnit("skiff", "ai", 500 + D, 500);
  flat.units.set(flatAttacker.id, flatAttacker);
  flat.units.set(flatTarget.id, flatTarget);
  updateCombat(flat, flatAttacker, 0.1);
  assert.equal(flatAttacker.autoTarget, null, "flat ground: the target sits beyond the un-extended aggro range");

  const high = createGameState({ planetId: "helix" });
  const map = high.map;
  const highAttacker = makeUnit("skiff", "player", map.width * 0.5, map.height * 0.5);
  const highTarget = makeUnit("skiff", "ai", map.width * 0.5 + D, map.height * 0.5);
  high.units.set(highAttacker.id, highAttacker);
  high.units.set(highTarget.id, highTarget);
  const tile = sampleTerrain(map.terrain, highAttacker.x, highAttacker.y);
  assert.equal(tile.name, "high", "fixture sanity: the attacker is standing on the ridge");

  updateCombat(high, highAttacker, 0.1);
  assert.equal(highAttacker.autoTarget, highTarget.id, "high ground: the identical distance is now inside the terrain-extended aggro range");
});

test("stillEngageable also folds in terrain: a high-ground unit keeps its already-locked target instead of switching to a closer one", () => {
  const D = 135;   // beyond flat aggro (120), inside this attacker's high-ground aggro (150)
  const high = createGameState({ planetId: "helix" });
  const map = high.map;
  const attacker = makeUnit("skiff", "player", map.width * 0.5, map.height * 0.5);
  // Locked from a (simulated) previous tick, out at the terrain-extended range.
  const lockedTarget = makeUnit("skiff", "ai", map.width * 0.5 + D, map.height * 0.5);
  // Well within the FLAT aggro range too — what acquireTarget would prefer if stillEngageable
  // ever fell through to it (nearer target, unmodified by the fix being tested here).
  const closerTarget = makeUnit("skiff", "ai", map.width * 0.5 + 60, map.height * 0.5);
  high.units.set(attacker.id, attacker);
  high.units.set(lockedTarget.id, lockedTarget);
  high.units.set(closerTarget.id, closerTarget);
  attacker.autoTarget = lockedTarget.id;

  updateCombat(high, attacker, 0.1);

  assert.equal(attacker.autoTarget, lockedTarget.id,
    "stillEngageable's own terrain-extended aggro holds the original lock, rather than falling through to acquireTarget and picking the closer enemy");
});

// ---- Uphill concealment, acquisition half (docs/improvement-proposals.md "A real LOS pass"):
// fog.js's reveal() already caps how far a NON-high-ground source sees onto high ground at
// UPHILL_FRAC of its sight; the identical rule applies here to weapon acquisition, so a unit
// can't shell a held ridge blind just because its raw aggro range happens to reach that far.
// Skiff aggroRange 120 * UPHILL_FRAC 0.55 = 66 — D=90 sits strictly beyond that cap but strictly
// inside the flat 120 aggro, isolating the effect exactly like the fog tests do.

test("a lowland attacker can't acquire a high-ground enemy beyond aggro*UPHILL_FRAC", () => {
  const D = 90;
  const state = createGameState({ planetId: "helix" });
  const map = state.map;
  const attacker = makeUnit("skiff", "player", map.width * 0.5 - 170, map.height * 0.5);
  assert.equal(sampleTerrain(map.terrain, attacker.x, attacker.y).name, "open", "fixture sanity: attacker starts off the ridge");
  const highTarget = makeUnit("skiff", "ai", attacker.x + D, attacker.y);
  assert.equal(sampleTerrain(map.terrain, highTarget.x, highTarget.y).name, "high", "fixture sanity: target sits on the ridge, D away");
  state.units.set(attacker.id, attacker);
  state.units.set(highTarget.id, highTarget);

  updateCombat(state, attacker, 0.1);

  assert.equal(attacker.autoTarget, null, "beyond the uphill-capped range — the attacker never acquires it, though it's well within the flat 120 aggro");
});

test("the identical distance is acquired normally when the target is NOT on high ground — the cap targets high ground specifically", () => {
  const D = 90;
  const state = createGameState({ planetId: "ferros" });   // all-open, no terrain at all
  const attacker = makeUnit("skiff", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + D, 500);
  state.units.set(attacker.id, attacker);
  state.units.set(target.id, target);

  updateCombat(state, attacker, 0.1);

  assert.equal(attacker.autoTarget, target.id, "same distance, open ground: acquired fine, same as before this feature");
});

test("the uphill acquisition cap is symmetric: an AI-owned attacker is capped identically against a player-owned high-ground target", () => {
  const D = 90;
  const state = createGameState({ planetId: "helix" });
  const map = state.map;
  const attacker = makeUnit("skiff", "ai", map.width * 0.5 - 170, map.height * 0.5);
  const highTarget = makeUnit("skiff", "player", attacker.x + D, attacker.y);
  assert.equal(sampleTerrain(map.terrain, highTarget.x, highTarget.y).name, "high", "fixture sanity");
  state.units.set(attacker.id, attacker);
  state.units.set(highTarget.id, highTarget);

  updateCombat(state, attacker, 0.1);

  assert.equal(attacker.autoTarget, null,
    "the AI reads acquireTarget through the exact same code path as the player — no separate AI-side change needed, and none was made");
});

// ---- anvilAura (the Aegis's guardAura): reduces damage taken by allies inside
// its bubble. Nothing before this landed a real hit through it.

test("a friendly Aegis's cryo-armour aura reduces damage taken by exactly its documented multiplier", () => {
  const unshielded = createGameState({ planetId: "ferros" });
  const [attacker1, target1] = faceOff(unshielded, 500, 500);
  const startHp1 = target1.hp;
  updateCombat(unshielded, attacker1, UNITS.skiff.cooldown);
  const unshieldedDamage = startHp1 - target1.hp;

  const shielded = createGameState({ planetId: "ferros" });
  const attacker2 = makeUnit("skiff", "player", 500, 500);
  const target2 = makeUnit("skiff", "ai", 500 + UNITS.skiff.range - 1, 500);   // within melee range, as faceOff would place it
  // Well within the target's 96-range guardAura, but past the attacker's own aggro
  // range (120) — otherwise it's a second enemy inside spreadEnemy's local band and
  // the attacker sometimes fans onto the Aegis itself instead of the intended target.
  const aegis = makeUnit("aegis", "ai", target2.x + 90, target2.y);
  shielded.units.set(attacker2.id, attacker2);
  shielded.units.set(target2.id, target2);
  shielded.units.set(aegis.id, aegis);
  collectAnvils(shielded);   // sim.js's per-tick anvil snapshot that combat.js's attackDamage reads (engine/sim.js)
  const startHp2 = target2.hp;

  updateCombat(shielded, attacker2, UNITS.skiff.cooldown);

  const shieldedDamage = startHp2 - target2.hp;
  const { damageTakenMult } = UNITS.aegis.guardAura;
  const expected = UNITS.skiff.attack * damageTakenMult;
  assert.ok(Math.abs(shieldedDamage - expected) < 1e-9, `expected exactly ${expected} with the Aegis's damage-taken multiplier applied, got ${shieldedDamage}`);
  assert.ok(shieldedDamage < unshieldedDamage, "and that's strictly less than the same attack against an unshielded target");
});

test("the Aegis's aura doesn't shield itself — the source's explicit exclusion, so it can still be focused down", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const aegis = makeUnit("aegis", "ai", 500 + UNITS.skiff.range - 1, 500);   // within melee range, and trivially within its OWN aura (distance 0)
  state.units.set(attacker.id, attacker);
  state.units.set(aegis.id, aegis);
  collectAnvils(state);
  const startHp = aegis.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  assert.equal(startHp - aegis.hp, UNITS.skiff.attack,
    "full damage landed — an Aegis standing inside its own aura radius doesn't reduce its own damage taken");
});

// ---- Colossus splash (docs/improvement-proposals.md "Colossus splash: def-driven area damage
// as the T3 anti-mass verb"): a generic def.splash = {radius, frac} mechanic, shipped on the
// Colossus first. After the primary hit lands, enemy units near the impact point (the primary
// target's own position) take dmg*frac*(1 - d/radius) falloff damage — punishing exactly the
// clumped, same-owner-packed formations separation.js produces. Enemy-only (never the attacker's
// own side) and units-only (never a building, however close one stands to the impact).

test("a splash attack damages a nearby enemy unit around the impact point, on top of the primary target's own hit", () => {
  const state = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.colossus.range - 1, 500);   // the primary hit, within weapon range
  const nearby = makeUnit("skiff", "ai", target.x + 10, target.y);              // 10 away from the impact — inside splash radius
  state.units.set(colossus.id, colossus);
  state.units.set(target.id, target);
  state.units.set(nearby.id, nearby);
  // Pin the primary target explicitly: with two enemies now in aggro range, the ordinary
  // dispersed auto-acquire (spreadEnemy) could otherwise fan onto either one — irrelevant to
  // what this test checks (splash's own falloff math), so an explicit order removes the ambiguity.
  colossus.order = { type: "attack", targetId: target.id };
  const targetStartHp = target.hp, nearbyStartHp = nearby.hp;

  updateCombat(state, colossus, UNITS.colossus.cooldown);

  const { radius, frac } = UNITS.colossus.splash;
  const expectedSplash = UNITS.colossus.attack * frac * (1 - 10 / radius);
  assert.ok(expectedSplash > 0, "sanity: 10 units is inside the tuned splash radius");
  assert.ok(Math.abs((nearbyStartHp - nearby.hp) - expectedSplash) < 1e-9,
    `expected splash damage ${expectedSplash}, got ${nearbyStartHp - nearby.hp}`);
  assert.equal(targetStartHp - target.hp, UNITS.colossus.attack,
    "the primary target itself takes only its plain direct hit — splash punishes units caught nearby, not a double-dip on the target");
});

test("splash damage falls off linearly with distance from the impact point", () => {
  const state = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.colossus.range - 1, 500);
  const near = makeUnit("skiff", "ai", target.x + 5, target.y);
  const far = makeUnit("skiff", "ai", target.x - 20, target.y);   // farther, but still inside the splash radius
  state.units.set(colossus.id, colossus);
  state.units.set(target.id, target);
  state.units.set(near.id, near);
  state.units.set(far.id, far);
  colossus.order = { type: "attack", targetId: target.id };   // pin the primary target — see comment above
  const nearStartHp = near.hp, farStartHp = far.hp;

  updateCombat(state, colossus, UNITS.colossus.cooldown);

  const nearDamage = nearStartHp - near.hp, farDamage = farStartHp - far.hp;
  assert.ok(farDamage > 0, "the farther bystander still takes some splash damage");
  assert.ok(nearDamage > farDamage, "the closer bystander takes strictly more splash damage than the farther one");
});

test("splash never reaches an enemy unit outside the splash radius", () => {
  const state = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.colossus.range - 1, 500);
  const { radius } = UNITS.colossus.splash;
  const outside = makeUnit("skiff", "ai", target.x + radius + 5, target.y);   // just past the splash radius
  state.units.set(colossus.id, colossus);
  state.units.set(target.id, target);
  state.units.set(outside.id, outside);
  colossus.order = { type: "attack", targetId: target.id };   // pin the primary target — see comment above
  const outsideHp = outside.hp;

  updateCombat(state, colossus, UNITS.colossus.cooldown);

  assert.equal(outside.hp, outsideHp, "an enemy outside the splash radius takes no splash damage at all");
});

test("splash never damages the attacker's own side, even standing right next to the impact point", () => {
  const state = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.colossus.range - 1, 500);
  const friendly = makeUnit("skiff", "player", target.x + 5, target.y);   // player-owned, well inside the blast
  state.units.set(colossus.id, colossus);
  state.units.set(target.id, target);
  state.units.set(friendly.id, friendly);
  colossus.order = { type: "attack", targetId: target.id };   // pin the primary target — see comment above
  const friendlyHp = friendly.hp;

  updateCombat(state, colossus, UNITS.colossus.cooldown);

  assert.equal(friendly.hp, friendlyHp, "a friendly unit inside the blast radius takes zero splash damage — no friendly fire");
});

test("splash never damages a building, even one standing well within the splash radius of a unit impact", () => {
  const state = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.colossus.range - 1, 500);
  // A building parked essentially on top of the impact point — colliders.js's canPlaceBuilding
  // only ever gates a BUILDING's placement against other buildings/nodes, never against units
  // ("Deliberately ignores units: they move"), so a unit standing this close to an enemy
  // building is a real in-game configuration, not a contrived one.
  const barracks = makeBuilding("barracks", "ai", target.x + 2, target.y);
  state.units.set(colossus.id, colossus);
  state.units.set(target.id, target);
  state.buildings.set(barracks.id, barracks);
  colossus.order = { type: "attack", targetId: target.id };   // pin the primary target — see comment above
  const barracksHp = barracks.hp;

  updateCombat(state, colossus, UNITS.colossus.cooldown);

  assert.equal(barracks.hp, barracksHp, "a building must never take splash damage, however close it stands to the impact");
});

test("a splash death still leaves battle wreckage and pushes its own entityKilled event, same as an ordinary kill", () => {
  const state = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.colossus.range - 1, 500);
  const nearby = makeUnit("skiff", "ai", target.x + 5, target.y);
  nearby.hp = 1;   // its share of splash is easily enough to kill it outright
  state.units.set(colossus.id, colossus);
  state.units.set(target.id, target);
  state.units.set(nearby.id, nearby);
  colossus.order = { type: "attack", targetId: target.id };   // pin the primary target — see comment above

  updateCombat(state, colossus, UNITS.colossus.cooldown);

  assert.equal(state.units.has(nearby.id), false, "the splash-killed bystander is removed from state");
  assert.ok(state.events.some(e => e.type === "entityKilled" && e.x === nearby.x && e.y === nearby.y),
    "the splash kill pushes its own entityKilled event");
  assert.equal(state.wrecks.length, 1, "the splash kill deposits battle wreckage through the same depositWreckage path");
});

test("multiple nearby enemies each take independently-computed splash damage from one primary hit — order-independent", () => {
  const state = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.colossus.range - 1, 500);
  const doomed = makeUnit("skiff", "ai", target.x + 5, target.y);    // close — dies to its share of splash
  const far = makeUnit("skiff", "ai", target.x - 20, target.y);      // farther — survives with a smaller hit
  doomed.hp = 5;
  state.units.set(colossus.id, colossus);
  state.units.set(target.id, target);
  state.units.set(doomed.id, doomed);
  state.units.set(far.id, far);
  colossus.order = { type: "attack", targetId: target.id };   // pin the primary target — see comment above
  const farStartHp = far.hp;

  updateCombat(state, colossus, UNITS.colossus.cooldown);

  assert.equal(state.units.has(doomed.id), false, "the closer, low-hp bystander dies to splash");
  const { radius, frac } = UNITS.colossus.splash;
  const expectedFarDamage = UNITS.colossus.attack * frac * (1 - 20 / radius);
  assert.ok(Math.abs((farStartHp - far.hp) - expectedFarDamage) < 1e-9,
    "the surviving bystander's own damage is unaffected by the other bystander dying in the same splash pass");
});

test("splash finds nearby enemies through the populated broad-phase grid too, not just the no-grid fallback", () => {
  const state = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 1000, 500);         // grid column ~10
  const target = makeUnit("skiff", "ai", 1000 + UNITS.colossus.range - 1, 500);
  const nearby = makeUnit("skiff", "ai", target.x + 10, target.y);
  state.units.set(colossus.id, colossus);
  state.units.set(target.id, target);
  state.units.set(nearby.id, nearby);
  colossus.order = { type: "attack", targetId: target.id };   // pin the primary target — see comment above
  state.unitGrid = buildUnitGrid(state);   // the real per-tick broad-phase index (engine/grid.js), same as sim.js builds every tick
  const nearbyHp = nearby.hp;

  updateCombat(state, colossus, UNITS.colossus.cooldown);

  assert.ok(nearby.hp < nearbyHp, "splash should find and damage the nearby enemy through the grid path too");
});

test("a non-splash attacker never applies any splash damage — def.splash is opt-in per unit", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  const bystander = makeUnit("skiff", "ai", b.x + 5, b.y);   // right next to the plain Skiff's own target
  state.units.set(bystander.id, bystander);
  a.order = { type: "attack", targetId: b.id };   // pin the target — two enemies now in aggro, and this test cares
                                                    // only about splash, not which one the plain dispersed pick lands on
  const bystanderHp = bystander.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(bystander.hp, bystanderHp, "a Skiff (no def.splash) never applies splash damage to anything nearby");
});

test("performAttack stamps splashRadius on the attackHit event for a splash attacker, and leaves it falsy for a plain one", () => {
  const splashState = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.colossus.range - 1, 500);
  splashState.units.set(colossus.id, colossus);
  splashState.units.set(target.id, target);

  updateCombat(splashState, colossus, UNITS.colossus.cooldown);

  const splashHit = splashState.events.find(e => e.type === "attackHit");
  assert.ok(splashHit, "expected an attackHit event");
  assert.equal(splashHit.splashRadius, UNITS.colossus.splash.radius);

  const plainState = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(plainState);

  updateCombat(plainState, a, UNITS.skiff.cooldown);

  const plainHit = plainState.events.find(e => e.type === "attackHit");
  assert.ok(plainHit, "expected an attackHit event");
  assert.ok(!plainHit.splashRadius, "a non-splash attacker's attackHit event carries no splashRadius");
});

// ---- The static-defense ladder (docs/improvement-proposals.md) ---------------------------------

// ---- Aegis Bastion (a static guard-aura projector, entities.js BUILDINGS.aegisbastion): the
// same anvilAura mechanic the Aegis UNIT's own guardAura already proves above (line ~908), now
// sourced from a BUILDING via sim.js collectAnvils' buildings pass. Positions mirror that existing
// unit-sourced test's own offsets/reasoning: the shield sits within its OWN 130-range aura of the
// target (100 away) but past the ATTACKER's aggro range (139 away, over the Skiff's 120), so the
// attacker can never acquire the shield itself instead of the intended target.

test("an Aegis Bastion's aura reduces damage taken by a friendly BUILDING inside its bubble, the same way the Aegis unit's aura shields a unit", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const target = makeBuilding("barracks", "ai", 500 + UNITS.skiff.range - 1, 500);   // within melee range, no attack of its own
  const aegisBastion = makeBuilding("aegisbastion", "ai", target.x + 100, target.y);   // within the projector's own 130-range aura
  state.units.set(attacker.id, attacker);
  state.buildings.set(target.id, target);
  state.buildings.set(aegisBastion.id, aegisBastion);
  collectAnvils(state);
  const startHp = target.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  const dmg = startHp - target.hp;
  const expected = UNITS.skiff.attack * BUILDINGS.aegisbastion.guardAura.damageTakenMult;
  assert.ok(Math.abs(dmg - expected) < 1e-9, `expected exactly ${expected} with the aura's damage-taken multiplier applied, got ${dmg}`);
});

test("an Aegis Bastion's aura reduces damage taken by a friendly UNIT inside its bubble too — anvilAura is target-kind-agnostic", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.skiff.range - 1, 500);
  const aegisBastion = makeBuilding("aegisbastion", "ai", target.x + 100, target.y);
  state.units.set(attacker.id, attacker);
  state.units.set(target.id, target);
  state.buildings.set(aegisBastion.id, aegisBastion);
  collectAnvils(state);
  const startHp = target.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  const dmg = startHp - target.hp;
  const expected = UNITS.skiff.attack * BUILDINGS.aegisbastion.guardAura.damageTakenMult;
  assert.ok(Math.abs(dmg - expected) < 1e-9, `expected exactly ${expected}, got ${dmg}`);
});

test("an Aegis Bastion's aura doesn't shield itself — anvilAura's existing id-exclusion check already covers a building source, not just a unit one", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const aegisBastion = makeBuilding("aegisbastion", "ai", 500 + UNITS.skiff.range - 1, 500);   // trivially within its own aura (distance 0)
  state.units.set(attacker.id, attacker);
  state.buildings.set(aegisBastion.id, aegisBastion);
  collectAnvils(state);
  const startHp = aegisBastion.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  assert.equal(startHp - aegisBastion.hp, UNITS.skiff.attack,
    "full damage landed — an Aegis Bastion standing inside its own aura radius doesn't reduce its own damage taken");
});

test("a still-constructing Aegis Bastion projects no aura yet — collectAnvils skips it until it's actually finished standing", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.skiff.range - 1, 500);
  const aegisBastion = makeBuilding("aegisbastion", "ai", target.x + 100, target.y, { constructing: true });
  state.units.set(attacker.id, attacker);
  state.units.set(target.id, target);
  state.buildings.set(aegisBastion.id, aegisBastion);
  collectAnvils(state);
  const startHp = target.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  assert.equal(startHp - target.hp, UNITS.skiff.attack, "no aura discount — the projector isn't finished yet");
});

// ---- Plasma Torpedo Battery (ammo-fed static defense, entities.js BUILDINGS.torpedobattery):
// updateBuildingCombat requires building.input[ammo.com] >= ammo.perShot before firing, and
// decrements it on every shot — a dry battery holds fire rather than shooting for free.

function batteryAt(state, x = 500, y = 500, ammo = 10) {
  const b = makeBuilding("torpedobattery", "player", x, y);
  b.input = { plasmatorp: ammo };
  state.buildings.set(b.id, b);
  return b;
}

test("a stocked Torpedo Battery fires on an enemy in range and decrements its ammo larder by exactly one shot's worth", () => {
  const state = createGameState({ planetId: "ferros" });
  const battery = batteryAt(state);
  const enemy = makeUnit("skiff", "ai", battery.x + 10, battery.y);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;
  const startAmmo = battery.input.plasmatorp;

  updateBuildingCombat(state, battery, BUILDINGS.torpedobattery.cooldown);

  assert.equal(startHp - enemy.hp, BUILDINGS.torpedobattery.attack, "landed its full attack");
  assert.equal(battery.input.plasmatorp, startAmmo - BUILDINGS.torpedobattery.ammo.perShot,
    "decremented the ammo larder by exactly one shot's worth");
});

test("a dry Torpedo Battery holds fire — a target in range and cooldown ready, but no ammo banked", () => {
  const state = createGameState({ planetId: "ferros" });
  const battery = batteryAt(state, 500, 500, 0);   // empty larder
  const enemy = makeUnit("skiff", "ai", battery.x + 10, battery.y);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, battery, BUILDINGS.torpedobattery.cooldown);

  assert.equal(enemy.hp, startHp, "a dry battery deals no damage — it holds fire rather than shooting for free");
  assert.equal(battery.targetId, enemy.id, "it still acquires/tracks the threat — only firing is gated, not targeting");
});

test("a Torpedo Battery with less than one shot's worth banked still holds fire", () => {
  const state = createGameState({ planetId: "ferros" });
  const battery = batteryAt(state, 500, 500, BUILDINGS.torpedobattery.ammo.perShot / 2);
  const enemy = makeUnit("skiff", "ai", battery.x + 10, battery.y);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, battery, BUILDINGS.torpedobattery.cooldown);

  assert.equal(enemy.hp, startHp, "half a shot isn't enough to fire");
});

test("a Torpedo Battery with no input buffer at all (never yet serviced) holds fire without throwing", () => {
  const state = createGameState({ planetId: "ferros" });
  const battery = makeBuilding("torpedobattery", "player", 500, 500);   // no .input set at all
  const enemy = makeUnit("skiff", "ai", battery.x + 10, battery.y);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  assert.doesNotThrow(() => updateBuildingCombat(state, battery, BUILDINGS.torpedobattery.cooldown));
  assert.equal(enemy.hp, startHp, "an unserviced battery has never fired a shot");
});

test("a Torpedo Battery resumes firing the instant its larder is topped back up past perShot, without waiting on a stale cooldown", () => {
  const state = createGameState({ planetId: "ferros" });
  const battery = batteryAt(state, 500, 500, 0);
  const enemy = makeUnit("skiff", "ai", battery.x + 10, battery.y);
  state.units.set(enemy.id, enemy);

  updateBuildingCombat(state, battery, BUILDINGS.torpedobattery.cooldown);   // dry — holds fire
  assert.equal(battery.attackTimer, 0, "an unfired shot never starts the cooldown — it stays ready to fire immediately");

  battery.input.plasmatorp = BUILDINGS.torpedobattery.ammo.perShot;   // a worker delivers a torpedo
  const startHp = enemy.hp;
  updateBuildingCombat(state, battery, 0.1);

  assert.ok(startHp - enemy.hp > 0, "fires the instant ammo is available");
  assert.equal(battery.input.plasmatorp, 0, "and consumes exactly the one shot's worth it just fired");
});

test("Overcharged Weapons and a dry magazine compose correctly: still holds fire regardless of the damage multiplier", () => {
  const state = createGameState({ planetId: "ferros" });
  const battery = batteryAt(state, 500, 500, 0);
  const enemy = makeUnit("skiff", "ai", battery.x + 10, battery.y);
  state.units.set(enemy.id, enemy);
  state.players.player.upgrades.overchargedWeapons = true;
  const startHp = enemy.hp;

  updateBuildingCombat(state, battery, BUILDINGS.torpedobattery.cooldown);

  assert.equal(enemy.hp, startHp, "no damage multiplier matters when the battery never fires at all");
});

/* ---------------------------------------------------------------------------------------------
   Veterancy ranks (docs/improvement-proposals.md "Veterancy ranks: kills forge small combat
   multipliers and visible chevrons"): each confirmed kill increments a UNIT-kind attacker's
   `kills` (buildings/turrets never accrue it); rankMults(unit) maps the running total to a
   damage-dealt/damage-taken multiplier pair via the 3/8/18 thresholds, applied in attackDamage
   beside the existing upgradeMult product — symmetrically for both sides, with zero AI-side code.
   --------------------------------------------------------------------------------------------- */

test("a unit-kind attacker's kills increments by exactly one when its hit kills the target", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  b.hp = 1;   // dies to this hit

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(a.kills, 1);
});

test("kills does not increment when the target survives the hit", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);   // full hp — this single hit won't kill it

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.ok(b.hp > 0, "fixture sanity: the target survived");
  assert.equal(a.kills, undefined, "no kill yet — the field is never even initialized");
});

test("a turret's (building-kind) attacker never accrues kills — veterancy is a unit-only trait", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  enemy.hp = 1;
  state.units.set(enemy.id, enemy);

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(state.units.has(enemy.id), false, "fixture sanity: the turret's hit did kill it");
  assert.equal(turret.kills, undefined, "buildings/turrets are never attacker.kind === 'unit'");
});

test("kills accumulates across repeated kills, one per confirmed kill", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  state.units.set(attacker.id, attacker);
  for (let i = 0; i < 3; i++) {
    const victim = makeUnit("skiff", "ai", 505, 500);
    victim.hp = 1;
    state.units.set(victim.id, victim);
    updateCombat(state, attacker, UNITS.skiff.cooldown);
  }

  assert.equal(attacker.kills, 3);
});

test("rankMults returns no bonus below the first veterancy threshold (0 kills, or a bare unit with no field at all)", () => {
  assert.deepEqual(rankMults({ kills: 0 }), { rank: 0, dealtMult: 1, takenMult: 1 });
  assert.deepEqual(rankMults({ kills: 2 }), { rank: 0, dealtMult: 1, takenMult: 1 });
  assert.deepEqual(rankMults({}), { rank: 0, dealtMult: 1, takenMult: 1 }, "a fresh unit off the line has no kills field yet");
});

test("rankMults confers rank 1 at 3 kills: +6% damage dealt, -6% damage taken", () => {
  const m = rankMults({ kills: 3 });
  assert.equal(m.rank, 1);
  assert.ok(Math.abs(m.dealtMult - 1.06) < 1e-9, `dealtMult ${m.dealtMult}`);
  assert.ok(Math.abs(m.takenMult - 0.94) < 1e-9, `takenMult ${m.takenMult}`);
});

test("rankMults confers rank 2 at 8 kills, stacking a second +6%/-6% layer", () => {
  const m = rankMults({ kills: 8 });
  assert.equal(m.rank, 2);
  assert.ok(Math.abs(m.dealtMult - 1.06 ** 2) < 1e-9);
  assert.ok(Math.abs(m.takenMult - 0.94 ** 2) < 1e-9);
});

test("rankMults confers rank 3 at 18 kills, the top of the ladder", () => {
  const m = rankMults({ kills: 18 });
  assert.equal(m.rank, 3);
  assert.ok(Math.abs(m.dealtMult - 1.06 ** 3) < 1e-9);
  assert.ok(Math.abs(m.takenMult - 0.94 ** 3) < 1e-9);
});

test("rankMults never exceeds rank 3 no matter how many kills pile up", () => {
  assert.equal(rankMults({ kills: 500 }).rank, 3);
});

test("rankMults thresholds are exclusive on the low side: one kill short of a threshold stays at the previous rank", () => {
  assert.equal(rankMults({ kills: 2 }).rank, 0);
  assert.equal(rankMults({ kills: 7 }).rank, 1);
  assert.equal(rankMults({ kills: 17 }).rank, 2);
});

test("a veteran attacker's rank multiplier applies in attackDamage, on top of the existing upgrade multipliers", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  a.kills = 3;   // rank 1
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const dealt = startHp - b.hp;
  const expected = UNITS.skiff.attack * rankMults(a).dealtMult;
  assert.ok(Math.abs(dealt - expected) < 1e-9, `expected ${expected}, dealt ${dealt}`);
});

test("a veteran defender's rank multiplier reduces the damage it takes", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  b.kills = 8;   // rank 2

  const startHp = b.hp;
  updateCombat(state, a, UNITS.skiff.cooldown);

  const dealt = startHp - b.hp;
  const expected = UNITS.skiff.attack * rankMults(b).takenMult;
  assert.ok(Math.abs(dealt - expected) < 1e-9, `expected ${expected}, dealt ${dealt}`);
});

test("veterancy applies symmetrically to an AI-owned attacker — no AI-side code needed", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const target = makeUnit("skiff", "player", 510, 500);
  attacker.kills = 3;
  state.units.set(attacker.id, attacker);
  state.units.set(target.id, target);
  const startHp = target.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  const dealt = startHp - target.hp;
  const expected = UNITS.skiff.attack * rankMults(attacker).dealtMult;
  assert.ok(Math.abs(dealt - expected) < 1e-9, "the AI's own veteran unit gets the identical bonus a player veteran would");
});

/* ---------------------------------------------------------------------------------------------
   Tiered destruction (docs/improvement-proposals.md "Tiered destruction: deaths scale with what
   died"): the entityKilled event carries unitType/kind on top of the pre-existing x/y/owner, so
   boot.js/effects.js/renderEffects.js/sound.js can scale the death's visuals and audio by what
   actually died. Purely additive fields — the state-mutation side (removeEntity, wreckage) is
   untouched, so byte-identical determinism holds.
   --------------------------------------------------------------------------------------------- */

test("performAttack's entityKilled event carries the dead entity's unitType and kind", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  b.hp = 1;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const ev = state.events.find(e => e.type === "entityKilled");
  assert.ok(ev, "fixture sanity: the hit killed the target");
  assert.equal(ev.unitType, "skiff");
  assert.equal(ev.kind, "unit");
});

test("a turret kill's entityKilled event carries the KILLED entity's unitType/kind, not the turret's", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  enemy.hp = 1;
  state.units.set(enemy.id, enemy);

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  const ev = state.events.find(e => e.type === "entityKilled");
  assert.ok(ev);
  assert.equal(ev.unitType, "skiff");
  assert.equal(ev.kind, "unit");
});

test("a splash kill's entityKilled event also carries unitType/kind", () => {
  const state = createGameState({ planetId: "ferros" });
  const colossus = makeUnit("colossus", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 500 + UNITS.colossus.range - 1, 500);
  const nearby = makeUnit("skiff", "ai", target.x + 10, target.y);
  nearby.hp = 1;   // dies to splash falloff
  state.units.set(colossus.id, colossus);
  state.units.set(target.id, target);
  state.units.set(nearby.id, nearby);
  colossus.order = { type: "attack", targetId: target.id };

  updateCombat(state, colossus, UNITS.colossus.cooldown);

  const splashKill = state.events.find(e => e.type === "entityKilled" && e.x === nearby.x && e.y === nearby.y);
  assert.ok(splashKill, "the splash-killed unit pushed its own entityKilled event");
  assert.equal(splashKill.unitType, "skiff");
  assert.equal(splashKill.kind, "unit");
});

test("a plain move order clears a stale auto-acquired target — a retreating unit is not still in combat mode (A13)", () => {
  // updateCombat returns before the acquisition block on a plain move, and combat.js:57 is the ONLY
  // place in the whole engine that writes autoTarget — so the field was unreachable-for-clearing for
  // the entire duration of a move. separation.js's isCombatMode reads it as a combat-mode register,
  // directly contradicting its own doc comment two lines above ("Deliberately NOT combat mode for a
  // plain 'move' order… a stale autoTarget reads as still-combat-mode for ONE TICK too long —
  // harmless"). Pulling a unit out of a fight with Move is the documented way to disengage, so
  // retreating units used the tight combat packing forever instead of the padded idle spacing.
  const s = createGameState({ planetId: "ferros", seed: 21 });
  s.units.clear();
  const mine = makeUnit("skiff", "player", 700, 500);
  const foe = makeUnit("skiff", "ai", 720, 500);
  s.units.set(mine.id, mine);
  s.units.set(foe.id, foe);

  updateCombat(s, mine, 0.1);
  assert.equal(mine.autoTarget, foe.id, "fixture sanity: it auto-acquired the enemy");

  mine.order = { type: "move", x: 200, y: 200 };
  updateCombat(s, mine, 0.1);
  assert.equal(mine.autoTarget, null,
    "a plain move order must clear the stale target rather than leaving the unit flagged combat-mode");
});
