/* ============================================================
   T-019a (ADR-0006): the client is the one untrusted actor in this whole codebase — everything it
   wants to change about the sim has to go out as a WireCommand (net/commandShapes.js) through
   game.transport.submitCommand, so a future real network client can never do more than a session
   handler explicitly allows. Two lines used to skip that path entirely, writing a simulation field
   straight from a click handler: hudSelection.js's "Clear home base" button (e.homeCC = null) and
   its Electrify toggle (e.electrified = v). Neither was exploitable by a human clicking their own
   UI, but both were the wrong shape for what this client is supposed to be — and the Electrify one
   was a genuine gap: nothing but that same client's own `e.owner === "player"` filter stood between
   a compromised/buggy client and wiring an OPPONENT's Habitat into their own grid.

   This file pins two things: the two new commands (setHomeBase's null case, setElectrified) work
   end to end through engine → session → the exact WireCommand shape hudSelection.js now sends, and
   a grep guard that no client file writes either field directly, so a regression back to the old
   shape fails the suite instead of quietly reopening the gap.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { issueSetHomeBase, issueSetElectrified } from "../engine/commands.js";
import { createSession } from "../server/session.js";

test("issueSetHomeBase(units, null) clears an assigned home base", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  issueSetHomeBase([worker], cc.id);
  assert.equal(worker.homeCC, cc.id, "fixture sanity: home base actually got set");

  issueSetHomeBase([worker], null);

  assert.equal(worker.homeCC, null, "null clears it, the same as the old direct e.homeCC = null write did");
});

test("issueSetElectrified sets/clears .electrified on eligible buildings, skips ineligible ones", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const turret = makeBuilding("turret", "player", cc.x + 100, cc.y);   // not electrifiable (defensive, not power-adjacent)
  state.buildings.set(turret.id, turret);

  issueSetElectrified([cc, turret], true);

  assert.equal(cc.electrified, true, "the Command Center is electrifiable");
  assert.equal(turret.electrified, undefined, "a turret is not — must be left untouched, not silently flipped on");

  issueSetElectrified([cc], false);
  assert.equal(cc.electrified, false);
});

test("issueSetElectrified, with an owner argument, refuses to electrify another owner's building", () => {
  const state = createGameState({ planetId: "ferros" });
  const enemyCC = [...state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");

  issueSetElectrified([enemyCC], true, "player");

  assert.equal(enemyCC.electrified, undefined, "a player-scoped call must never wire an opponent's building into their own grid");
});

test("T-019a: session.submitCommand(setHomeBase) accepts target: null end to end, the exact shape hudSelection.js now sends", () => {
  const session = createSession({ planetId: "ferros" });
  const state = session.getState();
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const set = session.submitCommand({ t: "setHomeBase", ids: [worker.id], target: cc.id });
  assert.equal(set.ok, true, "fixture sanity: setting it first must succeed");

  const cleared = session.submitCommand({ t: "setHomeBase", ids: [worker.id], target: null });

  assert.equal(cleared.ok, true, "a null target must be accepted, not rejected as malformed");
  assert.equal(worker.homeCC, null);
});

test("T-019a: session.submitCommand(setElectrified) round-trips the exact WireCommand shape hudSelection.js now sends", () => {
  const session = createSession({ planetId: "ferros" });
  const state = session.getState();
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");

  const res = session.submitCommand({ t: "setElectrified", ids: [cc.id], on: true });

  assert.equal(res.ok, true);
  assert.equal(cc.electrified, true);
});

test("T-019a: no CLIENT file assigns to .homeCC or .electrified directly — every write goes out as a command", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // Client code is the flat root-level .js files — engine/server/net/tools/test are all trusted
  // (they're the authority these commands round-trip THROUGH, not the untrusted actor this guards
  // against). No subdirectory holds client code today; if one appears, this walk deliberately
  // stays root-only rather than guessing at a recursive scope this task never asked for.
  const clientFiles = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".js"))
    .map(e => e.name);
  assert.ok(clientFiles.includes("hudSelection.js"), "fixture sanity: the walk actually reaches client code");

  const pattern = /\.(homeCC|electrified)\s*=(?!=)/;   // assignment, not a === / !== comparison
  const offenders = [];
  for (const name of clientFiles) {
    readFileSync(join(root, name), "utf8").split("\n").forEach((line, i) => {
      if (pattern.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "client line(s) still write a sim field directly:\n" + offenders.join("\n"));
});
