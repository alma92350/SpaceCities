import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameResources } from "../server/mcpResources.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { TECHS } from "../engine/techtree.js";

/* ============================================================
   T-055 (FR-16): "Static game reference... exposed as MCP resources, readable once rather than
   re-sent every turn." Deliberately the ONLY T-05x file with no lobby/getCache dependency at all
   — unlike every other MCP tool file, none of this content is per-match or per-seat: unit stats,
   the counter triangle, build costs and the tech tree are all fixed at the code level. Reuses the
   SAME tables combat/production/research already run on (engine/entities.js's UNITS/BUILDINGS,
   engine/techtree.js's TECHS) rather than a hand-maintained second copy that could drift — the
   counter triangle in particular is derived directly from each unit's own real `bonusVs` field,
   the exact data engine/combat.js's attackDamage reads, not a separately-authored description of
   it that could silently go stale the next time a balance pass changes a bonusVs number.
   ============================================================ */

function byUri(resources, uri) {
  const r = resources.find(x => x.uri === uri);
  assert.ok(r, `expected a resource at ${uri}`);
  return r;
}

test("createGameResources returns exactly the four documented resources, each with real static content", () => {
  const resources = createGameResources();
  assert.deepEqual(resources.map(r => r.uri).sort(), ["game://buildings", "game://counters", "game://tech-tree", "game://units"].sort());
  for (const r of resources) {
    assert.equal(typeof r.uri, "string");
    assert.equal(typeof r.name, "string");
    assert.equal(r.mimeType, "application/json");
    assert.equal(typeof r.text, "string");
    assert.doesNotThrow(() => JSON.parse(r.text), `${r.uri}'s own text must be valid JSON`);
  }
});

test("game://units carries real stats straight from engine/entities.js's own UNITS table, not a hand-authored duplicate", () => {
  const resources = createGameResources();
  const units = JSON.parse(byUri(resources, "game://units").text);
  const skiff = units.find(u => u.id === "skiff");
  assert.ok(skiff);
  assert.equal(skiff.name, UNITS.skiff.name);
  assert.equal(skiff.hp, UNITS.skiff.hp);
  assert.deepEqual(skiff.cost, UNITS.skiff.cost);
  assert.equal(skiff.attack, UNITS.skiff.attack);
  assert.deepEqual(skiff.bonusVs, UNITS.skiff.bonusVs);
  assert.equal(units.length, Object.keys(UNITS).length, "every unit type is present, none silently dropped");
});

test("game://buildings carries real stats straight from engine/entities.js's own BUILDINGS table", () => {
  const resources = createGameResources();
  const buildings = JSON.parse(byUri(resources, "game://buildings").text);
  const command = buildings.find(b => b.id === "command");
  assert.ok(command);
  assert.equal(command.name, BUILDINGS.command.name);
  assert.deepEqual(command.cost, BUILDINGS.command.cost);
  assert.deepEqual(command.produces, BUILDINGS.command.produces);
  assert.equal(buildings.length, Object.keys(BUILDINGS).length);
});

test("game://counters is DERIVED from each unit's own real bonusVs field — the documented Skiff/Bastion/Lancer triangle is present with its real numbers", () => {
  const resources = createGameResources();
  const counters = JSON.parse(byUri(resources, "game://counters").text);
  assert.deepEqual(counters.find(c => c.attacker === "skiff" && c.target === "lancer"), { attacker: "skiff", target: "lancer", bonus: UNITS.skiff.bonusVs.lancer });
  assert.deepEqual(counters.find(c => c.attacker === "bastion" && c.target === "skiff"), { attacker: "bastion", target: "skiff", bonus: UNITS.bastion.bonusVs.skiff });
  assert.deepEqual(counters.find(c => c.attacker === "lancer" && c.target === "bastion"), { attacker: "lancer", target: "bastion", bonus: UNITS.lancer.bonusVs.bastion });
  // A unit deliberately OUTSIDE the triangle (e.g. the Breacher, per entities.js's own comment)
  // contributes no entries at all — never a synthesized/zero bonus row standing in for "none".
  assert.equal(counters.some(c => c.attacker === "breacher" || c.target === "breacher"), false);
});

test("game://tech-tree carries real cost/time/prereqs straight from engine/techtree.js's own TECHS table", () => {
  const resources = createGameResources();
  const techs = JSON.parse(byUri(resources, "game://tech-tree").text);
  const metallurgy = techs.find(t => t.id === "metallurgy");
  assert.ok(metallurgy);
  assert.equal(metallurgy.name, TECHS.metallurgy.name);
  assert.deepEqual(metallurgy.cost, TECHS.metallurgy.cost);
  assert.equal(metallurgy.time, TECHS.metallurgy.time);
  const heavyalloys = techs.find(t => t.id === "heavyalloys");
  assert.deepEqual(heavyalloys.requires, ["metallurgy"]);
  assert.equal(techs.length, Object.keys(TECHS).length);
});

test("createGameResources is a pure function of the engine's own static tables — never touches a lobby, a match, or any per-seat state", () => {
  // No arguments accepted or needed — the strongest, simplest proof this content can never
  // accidentally become match-specific: there is nothing match-shaped to even pass in.
  assert.equal(createGameResources.length, 0);
  const a = createGameResources();
  const b = createGameResources();
  assert.deepEqual(a, b);
});
