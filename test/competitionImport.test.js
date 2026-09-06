/* ============================================================
   competitionScreens.js.s FILE-IMPORT path — loading somebody else's AI off disk.

   test/competition.test.js deliberately covers only competition.js's pure exports, and the note at
   the top of that file sends the DOM half to live browser verification. That is the right split
   for the rendering, but it left this particular block untested, and this block is not rendering:
   it is an UNTRUSTED-INPUT PARSER. A candidate file is a document a player was handed by someone
   else, and it is read, lifted into a genome, named, and written into the persisted ladder.

   The defences already exist and are well chosen — a byte cap before anything is read, JSON.parse
   rather than eval, sanitizeGenome's whitelist against GENOME_SCHEMA, a collision-free name. What
   was missing is any test that they are still wired up. Each of them fails SILENTLY when it
   regresses: a lifted genome that comes back empty imports an AI that plays like the default, and
   a dropped cap or a dropped sanitize step is invisible until a hostile file is the one being
   opened.

   The genome LIFT is the subtlest part and gets the most attention here: a candidate document
   stores its genome lowered into `overrides` rows keyed by an arbitrary name, so reading it back
   means picking rows out by position rather than by key, and every "no genome in here" shape has
   to come back as null rather than as an empty-but-plausible AI.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom, FakeElement } from "./_dom.js";

const doc = installFakeDom();

// A believable localStorage: saveLedgerToStorage writes through it, and its absence is swallowed
// by that function's own try/catch, which would hide a genuinely failed import behind a pass.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
};

// The one browser API this path needs that the shared DOM double has no business owning: a reader
// that hands back whatever text the test put in the file, or fails on demand.
class FakeFileReader {
  readAsText(file) {
    queueMicrotask(() => {
      if (file.unreadable) this.onerror?.(new Error("unreadable"));
      else { this.result = file.text; this.onload?.(); }
    });
  }
}
globalThis.FileReader = FakeFileReader;

const { genomeFromCandidate, MAX_AI_FILE_BYTES, importAiFromFile, reloadLedgerFromStorage } =
  await import("../competitionScreens.js");
const { toCandidate, genomeFrom, GENOME_SCHEMA } = await import("../tools/genome.js");

// A real, complete genome — toCandidate lowers every declared gene, so a hand-written partial one
// would fixture-fail for a reason that has nothing to do with importing.
const realGenome = () => genomeFrom({ strategy: "aggressive", archetype: "balanced" });
// Reset = an empty storage re-read. reloadLedgerFromStorage is the module's own accessor, so
// reading the ledger back after an import goes through the same door the app uses.
const resetLedger = () => { store.clear(); return reloadLedgerFromStorage(); };

// Drives importAiFromFile end to end: it builds its own <input type=file> and clicks it, so the
// test hands the next-created input a file and lets the change handler run.
async function importFile({ text = "{}", size = null, unreadable = false } = {}) {
  const created = [];
  const realCreate = doc.createElement.bind(doc);
  doc.createElement = tag => { const el = realCreate(tag); created.push(el); return el; };
  try {
    importAiFromFile();
    const input = created.find(el => el.tagName === "input");
    input.files = [{ size: size ?? text.length, text, unreadable }];
    input.dispatchEvent(new Event("change"));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  } finally { doc.createElement = realCreate; }
}

const rosterNames = ledger => ledger.roster.map(r => r.name);

test("a candidate document's genome is lifted back out of its lowered overrides rows", () => {
  // toCandidate is the exact function that WROTE the file, so round-tripping through it is the
  // only honest fixture: a hand-written one would pin whatever shape the test author imagined.
  const genome = realGenome();
  const lifted = genomeFromCandidate(toCandidate(genome, "Some AI"));
  assert.equal(lifted.strategy.garrisonMult, genome.strategy.garrisonMult);
  assert.ok(Object.keys(lifted.strategy).length > 3, "the whole strategy row must come back, not one field");
});

test("the lift reads rows by POSITION, not by a key it has to guess", () => {
  // The overrides rows are keyed by whatever name the file was saved under, which the reader
  // cannot know. Keying off a guessed name would work on files this build wrote and fail on
  // everyone else's.
  const doc_ = { overrides: { strategies: { "someone-elses-key": { garrisonMult: 0.5 } },
                              archetypes: { "another-key": { aggression: 2 } } } };
  assert.deepEqual(genomeFromCandidate(doc_).strategy, { garrisonMult: 0.5 });
  assert.deepEqual(genomeFromCandidate(doc_).archetype, { aggression: 2 });
});

test("a raw genome is passed through unchanged — a file may be either shape", () => {
  const raw = { strategy: { garrisonMult: 0.9 }, archetype: {} };
  assert.equal(genomeFromCandidate(raw), raw);
});

test("half a candidate still lifts: a strategy row alone, or an archetype row alone", () => {
  assert.deepEqual(genomeFromCandidate({ overrides: { strategies: { x: { garrisonMult: 0.5 } } } }).archetype, {});
  assert.deepEqual(genomeFromCandidate({ overrides: { archetypes: { x: { aggression: 2 } } } }).strategy, {});
});

test("anything carrying no genome at all lifts to null, never to an empty-but-plausible AI", () => {
  // The difference matters: null becomes a clear "that file carries no readable genome", while
  // `{strategy:{},archetype:{}}` would import successfully as an AI that silently plays default.
  for (const bad of [null, undefined, 42, "a string", [], {}, { overrides: {} },
                     { overrides: { strategies: {}, archetypes: {} } }]) {
    assert.equal(genomeFromCandidate(bad), null, `${JSON.stringify(bad)} must not lift to a genome`);
  }
});

test("the byte cap is far tighter than any real candidate, and rejects before reading", async () => {
  // A candidate is a few dozen numbers; the cap exists so a big file is rejected as a wrong file
  // rather than parsed. Checking the SIZE (not the parsed content) is what keeps that cheap.
  const real = JSON.stringify(toCandidate(realGenome(), "Real AI"));
  assert.ok(real.length * 20 < MAX_AI_FILE_BYTES, `the cap should have real headroom; a real file is ${real.length}B`);
  assert.ok(MAX_AI_FILE_BYTES <= 1024 * 1024, "…and stay tight enough that a big file is a wrong file");

  const before = rosterNames(resetLedger());
  await importFile({ text: real, size: MAX_AI_FILE_BYTES + 1 });
  assert.deepEqual(rosterNames(reloadLedgerFromStorage()), before,
    "an oversized file must not reach the roster");
});

test("an importable file lands on the roster under its own name", async () => {
  resetLedger();
  const file = JSON.stringify({ ...toCandidate(realGenome(), "Ada"), name: "Ada" });
  await importFile({ text: file });
  assert.deepEqual(rosterNames(reloadLedgerFromStorage()), ["Ada"]);
});

test("a name that is already taken gets the first free suffix, never a silent overwrite", async () => {
  // The player may still care about the entry already sitting there, and addRosterEntry throws on
  // a collision — so the alternative to suffixing is a failed import or a lost AI.
  resetLedger();
  const file = JSON.stringify({ ...toCandidate(realGenome(), "Ada"), name: "Ada" });
  await importFile({ text: file });
  await importFile({ text: file });
  await importFile({ text: file });
  assert.deepEqual(rosterNames(reloadLedgerFromStorage()), ["Ada", "Ada 2", "Ada 3"]);
});

test("an unnamed file still imports, under a default name", async () => {
  resetLedger();
  await importFile({ text: JSON.stringify({ overrides: { strategies: { k: { garrisonMult: 0.8 } } } }) });
  assert.deepEqual(rosterNames(reloadLedgerFromStorage()), ["Imported AI"]);
});

test("HOSTILE INPUT: unknown keys and out-of-range dials are stripped, not imported", async () => {
  // sanitizeGenome is a whitelist against GENOME_SCHEMA, and it is the only thing standing between
  // a file somebody was handed and the live AI tables. This asserts the wiring, not sanitizeGenome
  // itself (test/genome.test.js owns that).
  resetLedger();
  await importFile({ text: JSON.stringify({
    name: "Trojan",
    overrides: { strategies: { k: { garrisonMult: 0.8, __proto__: { polluted: true }, notAGene: "evil", garrisonMultXXL: 1e9 } } },
  }) });
  const ledger = reloadLedgerFromStorage();
  assert.deepEqual(rosterNames(ledger), ["Trojan"]);
  const stored = ledger.roster[0].genome;
  const allowed = new Set(GENOME_SCHEMA.map(g => g.key));
  for (const key of Object.keys(stored.strategy || {})) {
    assert.ok(allowed.has(key), `${key} is not a declared gene and must not have survived import`);
  }
  assert.equal(stored.notAGene, undefined);
  assert.equal(({}).polluted, undefined, "no prototype pollution from a parsed file");
});

test("malformed JSON, an empty file and an unreadable file all fail cleanly", async () => {
  for (const attempt of [{ text: "{ not json" }, { text: "null" }, { text: "{}" }, { text: "x", unreadable: true }]) {
    resetLedger();
    await importFile(attempt);
    assert.deepEqual(rosterNames(reloadLedgerFromStorage()), [],
      `${JSON.stringify(attempt)} must not reach the roster`);
  }
});

test("choosing no file at all is not an error", async () => {
  // The change event fires with an empty list when a player opens the picker and cancels.
  resetLedger();
  const created = [];
  const realCreate = doc.createElement.bind(doc);
  doc.createElement = tag => { const el = realCreate(tag); created.push(el); return el; };
  try {
    importAiFromFile();
    const input = created.find(el => el.tagName === "input");
    input.files = [];
    assert.doesNotThrow(() => input.dispatchEvent(new Event("change")));
  } finally { doc.createElement = realCreate; }
  assert.deepEqual(rosterNames(reloadLedgerFromStorage()), []);
});

test("the file picker asks for JSON, so a player is not shown every file on their disk", () => {
  const created = [];
  const realCreate = doc.createElement.bind(doc);
  doc.createElement = tag => { const el = realCreate(tag); created.push(el); return el; };
  try { importAiFromFile(); } finally { doc.createElement = realCreate; }
  const input = created.find(el => el.tagName === "input");
  assert.ok(input instanceof FakeElement);
  assert.equal(input.type, "file");
  assert.match(input.accept, /json/);
});
