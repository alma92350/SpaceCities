/* ============================================================
   Keeps engine/types.js honest about the shapes it claims to describe.

   CONTRIBUTING.md: "When you add or rename a field on a core shape, update its @typedef in
   engine/types.js in the same change." That rule was broken repeatedly and silently — twenty
   fields across seven typedefs had drifted out of the model, including State.playerAi, the
   central field of the self-play feature, omitted by the very commit that added it.

   Nothing caught it because the drift is INVISIBLE to the type checker: every factory assigns
   to a `const` before returning, so TypeScript never runs an excess-property check, and
   `checkJs` is off for files without the pragma. Worse, drift actively BLOCKS type adoption —
   annotating one function in engine/supply.js with @param {State} produced three errors in
   correct code, which teaches contributors that the checker is wrong.

   So this compares the declared @property names against the keys the factories ACTUALLY
   construct, at runtime. Runtime keys, not a text parse of the literal: it can't be fooled by
   formatting, and it is exactly the set a `// @ts-check`ed caller will try to read.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { createGameState, createAiController } from "../engine/state.js";
import { createDiplomacy } from "../engine/diplomacy.js";
import { createGalaxy } from "../engine/galaxy.js";
import { createLedger, addRosterEntry, recordCompetition, standingsFor } from "../competitionLedger.js";
import { walkJs } from "./_helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const typesSrc = readFileSync(join(root, "engine", "types.js"), "utf8");

// The @property names declared under one `@typedef {Object} <Name>` block. A block runs to the
// end of its JSDoc comment, so a later typedef's properties can't leak in.
function declaredProps(typedefName) {
  // Anchored with /\r?$/m rather than a literal "\n". The end-of-line anchor is load-bearing — it
  // is what stops `@typedef {Object} State` from also matching a hypothetical `StateSnapshot` — so
  // it cannot just be dropped. But hardcoding "\n" made all five cases below fail on a CRLF
  // checkout, and a drift guard that fails OPEN is the worst kind: `npm run typecheck` was the only
  // thing left watching these shapes, which is exactly the hole this file was written to close.
  // .gitattributes now pins the checkout to LF; this stays line-ending-agnostic regardless, because
  // a guard that reads its own source tree should not depend on how that tree was cloned.
  const start = typesSrc.search(new RegExp(`@typedef \\{Object\\} ${typedefName}\\r?$`, "m"));
  assert.notEqual(start, -1, `engine/types.js declares no @typedef {Object} ${typedefName}`);
  const block = typesSrc.slice(start, typesSrc.indexOf("*/", start));
  return new Set([...block.matchAll(/@property\s+\{.*\}\s+\[?([A-Za-z_$][\w$]*)\]?/g)].map(m => m[1]));
}

const CASES = [
  ["State", () => createGameState({ planetId: "ferros", seed: 1 })],
  ["AiState", () => createAiController("ferros")],
  ["Diplomacy", () => createDiplomacy()],
  ["Galaxy", () => createGalaxy({ seed: 1 })],
  ["GalaxySettings", () => createGalaxy({ seed: 1 }).settings],
];

for (const [name, build] of CASES) {
  test(`every field ${name}'s factory constructs is declared on the ${name} typedef`, () => {
    const declared = declaredProps(name);
    const constructed = Object.keys(build()).sort();
    assert.ok(constructed.length > 0, `fixture sanity: the ${name} factory returned an empty object`);
    assert.deepEqual(constructed.filter(k => !declared.has(k)), [],
      `engine/types.js's ${name} typedef is missing @property lines for field(s) its factory ` +
      `constructs — a // @ts-check'ed caller reading one gets a spurious error in correct code`);
  });
}

/* ============================================================
   THE SAME CONTRACT, FOR THE COMPETITION SHAPES

   The five cases above cover engine/types.js's `@typedef {Object}` + `@property` blocks. The
   competition stack writes its typedefs the other way — inline `@typedef {{ a: X, b: Y }} Name`,
   in competitionLedger.js rather than engine/types.js — so none of them were checked by anything,
   and RosterEntry drifted exactly the way State.playerAi once did: addRosterEntry grew a `genome`
   field that the typedef never declared. That is not a hypothetical. It is what turned
   `npm run typecheck` red for two days and merged to main twice, because the only thing that could
   see it was tsc, running in CI, on a build everyone had stopped reading.

   These shapes deserve the guard MORE than GalaxySettings does, not less: a roster entry and a
   ledger are user-facing data that gets persisted to localStorage, exported to a file, and
   imported back from an untrusted one.
   ============================================================ */

// Keys of an inline `@typedef {{ ... }} Name`. Depth-aware on purpose: these types nest real
// generics (`Object.<string, LedgerRatingsTable>`, `Array<{ difficulty: string, ... }>`), so a
// naive split on "," would shred them and invent property names out of the fragments.
function declaredInlineProps(src, typedefName) {
  // Brace-MATCHED, not regex-captured. A `@typedef\s*\{\{([\s\S]*?)\}\}\s+Name` pattern looks
  // right and is not: the lazy quantifier still starts at the FIRST `@typedef {{` in the file, so
  // asking for a typedef declared later returns a body spanning every typedef in between (found
  // by this file's own parser guard, which is why that guard exists). Walking the braces from each
  // `@typedef {{` to its own close is the only way to attribute a body to the right name.
  let body = null;
  for (const m of src.matchAll(/@typedef\s*\{\{/g)) {
    let i = m.index + m[0].length - 1, depth = 1;   // sit on the inner `{`
    while (i + 1 < src.length && depth > 0) {
      i++;
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    const after = src.slice(i + 1);
    const name = /^\}\s*([A-Za-z_$][\w$]*)/.exec(after);
    if (name && name[1] === typedefName) {
      body = src.slice(m.index + m[0].length, i);
      break;
    }
  }
  assert.ok(body != null, `no inline @typedef {{...}} ${typedefName} found`);
  const keys = new Set();
  let depth = 0, field = "";
  const flush = () => {
    const head = field.split(":")[0].trim().replace(/\?$/, "");
    if (/^[A-Za-z_$][\w$]*$/.test(head)) keys.add(head);
    field = "";
  };
  for (const ch of body) {
    if ("{<([".includes(ch)) depth++;
    else if ("}>)]".includes(ch)) depth--;
    if (ch === "," && depth === 0) flush(); else field += ch;
  }
  flush();
  return keys;
}

const ledgerSrc = readFileSync(join(root, "competitionLedger.js"), "utf8");

const LEDGER_CASES = [
  // A roster entry carrying a GENOME specifically — the exact shape whose missing declaration
  // broke the build. A genome-less entry omits the field entirely, so it would not have caught it.
  ["RosterEntry", () => {
    const l = createLedger();
    addRosterEntry(l, { name: "Genomed", genome: { strategy: {}, archetype: {} } });
    assert.ok(l.roster[0].genome, "fixture sanity: the entry must actually carry a genome");
    return l.roster[0];
  }],
  ["CompetitionLedger", () => createLedger()],
  // standingsFor's rows are what the Standings screen renders, so a field it constructs but never
  // declares is a column the UI reads through an `any`.
  ["Standing", () => {
    const l = createLedger();
    addRosterEntry(l, { name: "A" });
    addRosterEntry(l, { name: "B" });
    recordCompetition(l, {
      difficulty: "medium", aName: "A", bName: "B",
      rows: [{ aName: "A", bName: "B", winner: "a", margin: 3 }],
    });
    const rows = standingsFor(l, "medium");
    assert.ok(rows.length > 0, "fixture sanity: a rated match should produce a standings row");
    return rows[0];
  }],
];

for (const [name, build] of LEDGER_CASES) {
  test(`every field ${name}'s factory constructs is declared on the ${name} typedef`, () => {
    const declared = declaredInlineProps(ledgerSrc, name);
    const constructed = Object.keys(build()).sort();
    assert.ok(constructed.length > 0, `fixture sanity: the ${name} factory returned an empty object`);
    assert.deepEqual(constructed.filter(k => !declared.has(k)), [],
      `competitionLedger.js's ${name} typedef is missing declaration(s) for field(s) it actually ` +
      `constructs — this is the drift that broke npm run typecheck`);
  });
}

test("the inline-typedef parser survives the nested generics these shapes really use", () => {
  // A guard on the parser, same reason declaredProps has one: a regex that quietly returned an
  // empty set, or one shredded by the commas inside `Object.<string, X>`, would make all three
  // tests above pass on anything at all.
  const keys = declaredInlineProps(ledgerSrc, "CompetitionLedger");
  assert.deepEqual([...keys].sort(),
    ["gauntlet", "history", "ratingsByDifficulty", "roster", "seasons", "v"],
    "the parser must read every top-level key and not split inside Object.<string, ...>");

  // And that a genuinely missing field is REPORTED, not silently tolerated.
  const declared = declaredInlineProps(ledgerSrc, "RosterEntry");
  assert.ok(declared.has("genome"), "RosterEntry must declare the optional genome field");
  assert.deepEqual(
    Object.keys({ ...createLedger().roster[0], notADeclaredField: 1 }).filter(k => !declared.has(k)),
    ["notADeclaredField"]);
});

test("every // @ts-check file actually annotates its exported functions", () => {
  // The pragma alone buys nothing. jsconfig.json sets strict:false and noImplicitAny:false, so an
  // un-annotated `state`/`unit`/`building` param is `any` — measured, twelve of the biggest engine
  // files (sim.js, persist.js, combat.js among them) can adopt the pragma for ZERO errors and gain
  // zero checking. engine/recycle.js was already in exactly that state in-tree: pragma on line 1,
  // seven exports, not one @param. Without this guard a coverage push raises the percentage and
  // catches nothing. Annotation density is the real metric, so that is what's asserted.
  const bare = [];
  for (const file of walkJs(root)) {
    const rel = relative(root, file);
    if (rel.startsWith("test" + sep) || rel.startsWith("tools" + sep)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    if (!lines[0].includes("@ts-check")) continue;
    lines.forEach((line, i) => {
      const m = line.match(/^export (?:async )?function (\w+)/);
      if (!m) return;
      let j = i - 1, doc = "";
      while (j >= 0 && /^\s*(\*|\/\*)/.test(lines[j])) { doc = lines[j] + "\n" + doc; j--; }
      if (!/@(param|returns)\s*\{/.test(doc)) bare.push(`${rel} → ${m[1]}`);
    });
  }
  assert.deepEqual(bare, [],
    "exported function(s) in a // @ts-check'ed file with no typed @param/@returns — the pragma is " +
    "on but checks nothing for them:\n" + bare.join("\n"));
});

test("the contract check actually bites — an undeclared field is reported by name", () => {
  // Without this, the tests above would keep passing if declaredProps ever silently returned
  // "everything" (a broken regex, a renamed typedef). Give it an object carrying a field no
  // typedef declares and require it to be named.
  const declared = declaredProps("Diplomacy");
  assert.ok(declared.has("stance"), "sanity: the parser found a known Diplomacy property");
  const withExtra = { ...createDiplomacy(), notADeclaredField: 1 };
  assert.deepEqual(Object.keys(withExtra).filter(k => !declared.has(k)), ["notADeclaredField"]);
});
