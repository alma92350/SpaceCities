/* ============================================================
   T-058 (P2): the reference scripted agent — a genuine, runnable example of an MCP client playing
   SpaceCities, built using ONLY the documented tool surface (docs/agent-guide.md), the same way any
   third-party agent developer would. Deliberately NOT a strong bot: engine/ai.js already is one,
   and duplicating its strategy here would teach the wrong lesson. This file's own job is to show
   the CORRECT PROTOCOL SHAPE — join once, read static rules once, then loop
   observe -> decide -> act -> wait_for_event — clearly enough that docs/agent-guide.md can walk
   through it line by line.

   Usage
     node tools/referenceAgent.js run --url http://localhost:7860 [--match <id>] [--seat 1]
                                       [--rounds 20] [--wait-ms 5000]
   With no --match, it joins the first open match tools/serve.js's own GET /api/matches lists.
   ============================================================ */

"use strict";

import { createMcpClient } from "./mcpClient.js";

/**
 * A deliberately simple, two-rule strategy, read straight off MCP-exposed data (never a direct
 * engine import — a real third party has no such access):
 *   1. If any enemy is currently visible, send every owned NON-building unit to attack-move it.
 *   2. Otherwise, queue whatever this seat's first producing building can currently afford, using
 *      game://buildings' own `produces` list (which unit types a building can build) crossed with
 *      get_tech_options' own prereqs_met/affordable flags for THIS seat right now.
 * Returns a WireCommand (net/commandShapes.js) ready for issue_command, or null for "do nothing
 * this round" (a legitimate, common outcome — an idle economy with nothing new to afford).
 * @param {{owner:string, entities:Object[], buildingDefs:Object[], techOptions:Object[]}} ctx
 * @returns {Object|null}
 */
export function decide({ owner, entities, buildingDefs, techOptions }) {
  const buildingTypeIds = new Set(buildingDefs.map(b => b.id));
  const enemies = entities.filter(e => e.owner !== owner);
  const ownUnits = entities.filter(e => e.owner === owner && !buildingTypeIds.has(e.type));
  const ownBuildings = entities.filter(e => e.owner === owner && buildingTypeIds.has(e.type));

  if (enemies.length > 0 && ownUnits.length > 0) {
    const target = enemies[0];
    return { t: "attackMove", ids: ownUnits.map(u => u.id), x: target.x, y: target.y };
  }

  for (const building of ownBuildings) {
    const def = buildingDefs.find(b => b.id === building.type);
    for (const unitType of def?.produces ?? []) {
      const option = techOptions.find(o => o.type === unitType);
      if (option?.prereqs_met && option?.affordable) {
        return { t: "queueProduction", building: building.id, u: unitType };
      }
    }
  }
  return null;
}

/**
 * Joins (or is handed) a match and plays it round by round until it ends, `maxRounds` is reached,
 * or the caller's own `signal` aborts. Returns a small summary rather than throwing on a normal
 * game-over, so a caller (or a test) can inspect how the run went.
 * @param {{
 *   baseUrl: string, matchId?: string, seatIndex?: number, maxRounds?: number,
 *   waitTimeoutMs?: number, startupTimeoutMs?: number, startupRetryMs?: number,
 *   log?: (line:string) => void,
 * }} opts
 */
export async function runReferenceAgent(opts) {
  const {
    baseUrl, matchId, seatIndex, maxRounds = Infinity, waitTimeoutMs = 5000,
    startupTimeoutMs = 20000, startupRetryMs = 500, log = () => {},
  } = opts;
  const client = createMcpClient(baseUrl);

  let targetMatchId = matchId;
  if (!targetMatchId) {
    const listed = await client.callTool("list_matches");
    const open = listed.structuredContent.matches[0];
    if (!open) throw new Error("no open matches to join — create one first (POST /api/matches)");
    targetMatchId = open.id;
  }

  const joined = await client.callTool("join_match", { match_id: targetMatchId, seat_index: seatIndex });
  if (joined.isError) throw new Error(`join_match failed: ${joined.content[0].text}`);
  const { seat_handle, owner } = joined.structuredContent;
  log(`Joined match ${targetMatchId} as seat "${owner}".`);

  // join_match only ever succeeds on an OPEN match (server/lobby.js's own joinMatch rule) — the
  // host still has to START it separately (POST /api/matches/:id/start), which can happen any
  // time after this agent joins, not necessarily before. Every observation/action tool reports
  // "match-not-live" (isError, no structuredContent) until that happens, so a real agent needs to
  // tolerate the gap rather than assume the match is already running the instant it has a seat.
  const startDeadline = Date.now() + startupTimeoutMs;
  for (;;) {
    const probe = await client.callTool("get_situation", { seat_handle });
    if (!probe.isError) break;
    if (Date.now() >= startDeadline) throw new Error(`match ${targetMatchId} never started within ${startupTimeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, startupRetryMs));
  }

  // Static reference data — read ONCE per match, per docs/agent-guide.md's own guidance (T-055's
  // whole point: "readable once rather than re-sent every turn"), never re-fetched inside the loop.
  const buildingsRes = await client.readResource("game://buildings");
  const buildingDefs = JSON.parse(buildingsRes.contents[0].text);

  let rounds = 0;
  let over = false;
  for (; rounds < maxRounds; rounds++) {
    const situation = (await client.callTool("get_situation", { seat_handle })).structuredContent;
    if (situation.over) { over = true; log(`Match over at tick ${situation.tick}.`); break; }

    const entities = (await client.callTool("list_entities", { seat_handle })).structuredContent.entities;
    const techOptions = (await client.callTool("get_tech_options", { seat_handle })).structuredContent.units;
    const command = decide({ owner, entities, buildingDefs, techOptions });
    if (command) {
      const result = await client.callTool("issue_command", { seat_handle, command });
      log(result.isError ? `Command rejected: ${result.content[0].text}` : `Issued ${command.t}.`);
    }

    // Block for something new to react to rather than polling in a tight loop (FR-17, T-054) —
    // a timeout is a normal outcome (nothing changed), not a reason to stop.
    await client.callTool("wait_for_event", { seat_handle, timeout_ms: waitTimeoutMs });
  }
  return { matchId: targetMatchId, owner, rounds, over };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : "true";
    else out._.push(a);
  }
  return out;
}

const USAGE = `REFERENCE AGENT — a minimal MCP client that plays SpaceCities (see docs/agent-guide.md).

  node tools/referenceAgent.js run --url http://localhost:7860 [--match <id>] [--seat <index>]
                                    [--rounds 20] [--wait-ms 5000]`;

async function runCmd(args) {
  if (!args.url) { console.log(USAGE); process.exitCode = 1; return; }
  const summary = await runReferenceAgent({
    baseUrl: args.url,
    matchId: args.match,
    seatIndex: args.seat !== undefined ? Number(args.seat) : undefined,
    maxRounds: args.rounds !== undefined ? Number(args.rounds) : undefined,
    waitTimeoutMs: args["wait-ms"] !== undefined ? Number(args["wait-ms"]) : undefined,
    log: line => console.log(line),
  });
  console.log(`-- ${summary.rounds} round(s) played, over=${summary.over} --`);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "run") { runCmd(args).catch(err => { console.error(err.message); process.exitCode = 1; }); return; }
  console.log(USAGE);
}

// Only run the CLI when invoked directly, so a test can import decide()/runReferenceAgent() above.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main(process.argv.slice(2));
