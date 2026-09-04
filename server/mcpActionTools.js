/* ============================================================
   T-053 (FR-15): action tools — mapped directly onto the Phase 2 wire codec
   (net/commandEnvelope.js's encode/net/commandCodec.js), never a second, parallel command path.
   ONE tool, `issue_command`, whose `command` argument IS a WireCommand (net/commandShapes.js's
   own documented union) — the same shape input.js/inputCommands.js already build for a human
   player, and the ONLY wire shape server/matchWorker.js's own admit()/stepMatch ever accepts.
   "Validation identical to a human's" (this task's own exit criterion) follows from that
   directly: an agent's command goes through the EXACT SAME ownership/fog/rate-limit checks
   (net/commandCodec.js) as a real WebSocket connection's, because it IS the same codec, reached
   the same way (server/mcpCommandBridge.js's sendCommand mirrors net/wsWorkerTransport.js's own
   worker.postMessage({type:"command", seat, envelope}) exactly).

   "Batched, group-oriented" (this task's own row title) is likewise not new work here: every
   WireCommand's own `ids` array already holds 1..400 unit ids (net/commandShapes.js), and
   `{t:"batch", c:[...]}` already applies up to 16 commands together at one tick — a single
   `issue_command` call inherits both for free by construction, not by anything this file adds.

   Deliberately ONE flexible tool rather than ~20 narrow ones (move_units, attack_units, ...):
   the wire command union is large and already fully specified/documented/tested elsewhere
   (net/commandShapes.js, net/commandCodec.js's own test suite) — wrapping each variant in its
   own MCP tool would just be that same union spelled out 20 different ways, all converging on
   the identical bridge call underneath.

   T-056 (§6.3, ADR-0007): every issue_command call is now also gated by a published APM ceiling
   (net/agentApm.js) BEFORE it ever reaches the bridge/worker — safe to apply unconditionally,
   with no seat/controller-kind check at all, because this tool is the ONLY path that ever reaches
   this code: a real human's browser client plays over the WebSocket transport and never calls an
   MCP tool, so this can never rate-limit a human by mistake (see net/agentApm.js's own header for
   why the gate lives here, transport-side, rather than inside engine State the way the scripted
   AI's own aiApm mechanism does).
   ============================================================ */

"use strict";

import { withSeat, rejection } from "./mcpSeatHandle.js";

const COMMAND_SCHEMA = {
  type: "object",
  description:
    "A WireCommand (net/commandShapes.js). The discriminator field `t` selects the shape; " +
    "common ones: {t:'move',ids,x,y,q?}, {t:'attackMove',ids,x,y,q?}, {t:'attack',ids,target,q?}, " +
    "{t:'gather',ids,node,q?}, {t:'stop',ids}, {t:'hold',ids}, {t:'build',worker,b,x,y}, " +
    "{t:'queueProduction',building,u,alt?}, {t:'researchTech',building,tech}. " +
    "`ids` is an array of 1-400 unit/building ids you own. Wrap several commands in " +
    "{t:'batch',c:[...]} (max 16) to apply them together at the same tick.",
  properties: { t: { type: "string" } },
  required: ["t"],
};

/**
 * @param {Object} lobby a createLobby() instance
 * @param {(matchId:string) => {sendCommand:(seat:string,cmd:Object)=>Promise<Object>}|null} getBridge
 *   looks up a LIVE match's own command bridge by id (tools/serve.js's own liveMatches) — null
 *   for a match that hasn't started yet, the same shape server/mcpObservationTools.js's own
 *   getCache uses for the identical reason (many concurrent matches, each its own worker).
 * @param {(matchId:string) => {tryConsume:(owner:string,nowMs:number)=>boolean}|null} [getApmGuard]
 *   looks up a LIVE match's own APM guard by id (net/agentApm.js's createAgentApmGuard, one per
 *   match, the same routing shape as getBridge/getCache for the identical reason). Defaults to
 *   "no guard anywhere" (unthrottled) — the same graceful-degradation default
 *   engine/aiCommon.js's own apm==null already uses — so every caller/test built before T-056
 *   keeps working unchanged.
 */
export function createActionTools(lobby, getBridge, getApmGuard = () => null) {
  return [
    {
      name: "issue_command",
      title: "Issue a unit/building/production command",
      description:
        "Submits a command for the calling seat's own units/buildings — the same wire command " +
        "a human player's client sends, validated by the identical server-side codec (ownership, " +
        "fog, affordability, rate limits). A rejected command reports the same machine-readable " +
        "reject code a human's own rejected click would get, so you can adjust and retry. Subject " +
        "to a published actions-per-minute ceiling — a burst of calls beyond that budget is " +
        "rejected the same way, not silently queued.",
      inputSchema: {
        type: "object",
        properties: { seat_handle: { type: "string" }, command: COMMAND_SCHEMA },
        required: ["seat_handle", "command"],
      },
      handler: withSeat(lobby, async ({ seat, command }) => {
        const bridge = getBridge(seat.matchId);
        if (!bridge) return rejection("match-not-live: this match hasn't started yet");
        const apmGuard = getApmGuard(seat.matchId);
        if (apmGuard && !apmGuard.tryConsume(seat.owner, Date.now())) {
          return rejection("agent-apm-exceeded: action budget exhausted, try again shortly");
        }
        const result = await bridge.sendCommand(seat.owner, command);
        if (result.ok) {
          return { content: [{ type: "text", text: "Command applied." }], structuredContent: result.result ?? {} };
        }
        return { content: [{ type: "text", text: `Command rejected: ${result.code}` }], isError: true, structuredContent: { code: result.code } };
      }),
    },
  ];
}
