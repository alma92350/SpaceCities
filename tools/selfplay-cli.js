/* ============================================================
   SELF-PLAY CLI — the Node entry point for tools/selfplay.js's pure self-play core. Split out (see
   docs/competitions-and-elo.md Phase 0) so tools/selfplay.js itself stays free of `process`/
   `document` and can be imported from a browser main thread or a Worker, not just Node. This file
   is Node-only by design — it's the thing that CAN'T be imported from a browser — so all of that
   lives here instead.

   Usage
     node tools/selfplay-cli.js run [--world ferros] [--seed 1] [--minutes 40]
                                    [--ai-strategy default] [--ai-difficulty medium]
                                    [--player-strategy default] [--player-difficulty medium]
   ============================================================ */

"use strict";

import { fileURLToPath } from "node:url";
import { createSelfPlayState, runSelfPlayMatch } from "./selfplay.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : "true";
    else out._.push(a);
  }
  return out;
}

function runCmd(args) {
  const state = createSelfPlayState({
    planetId: args.world || "ferros",
    seed: args.seed !== undefined ? Number(args.seed) : 1,
    matchTimeLimit: args.minutes !== undefined ? Number(args.minutes) * 60 : undefined,
    ai: { strategy: args["ai-strategy"], difficulty: args["ai-difficulty"] },
    playerAi: { strategy: args["player-strategy"], difficulty: args["player-difficulty"] },
  });
  const result = runSelfPlayMatch(state);
  const unitsOf = o => [...state.units.values()].filter(u => u.owner === o).length;
  const buildingsOf = o => [...state.buildings.values()].filter(b => b.owner === o).length;
  console.log(`world=${state.planetId} seed=${state.seed}`);
  console.log(`ai:     strategy=${state.ai.strategy} difficulty=${state.ai.difficulty}`);
  console.log(`player: strategy=${state.playerAi.strategy} difficulty=${state.playerAi.difficulty}`);
  console.log(`--`);
  console.log(`over=${result.over} winner=${result.winner} reason=${result.winReason} `
    + `time=${result.time.toFixed(1)}s tick=${result.tick}`);
  console.log(`ai:     units=${unitsOf("ai")} buildings=${buildingsOf("ai")} `
    + `resources=${JSON.stringify(state.players.ai.resources)}`);
  console.log(`player: units=${unitsOf("player")} buildings=${buildingsOf("player")} `
    + `resources=${JSON.stringify(state.players.player.resources)}`);
}

const USAGE = `SELF-PLAY — drive BOTH sides of a skirmish with the real AI (Tier 1).

  node tools/selfplay-cli.js run [--world ferros] [--seed 1] [--minutes 40]
                                 [--ai-strategy default] [--ai-difficulty medium]
                                 [--player-strategy default] [--player-difficulty medium]`;

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (cmd === "run") { runCmd(args); return; }
  console.log(USAGE);
}

// Only run the CLI when invoked directly, so a test can import the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
