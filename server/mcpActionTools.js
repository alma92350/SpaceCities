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

import { withSeat, rejection, requirePlayingSeat } from "./mcpSeatHandle.js";

const COMMAND_SCHEMA = {
  type: "object",
  description:
    "A WireCommand (net/commandShapes.js). The discriminator field `t` selects the shape; " +
    "common ones: {t:'move',ids,x,y,q?}, {t:'attackMove',ids,x,y,q?}, {t:'attack',ids,target,q?}, " +
    "{t:'gather',ids,node,q?}, {t:'stop',ids}, {t:'hold',ids}, {t:'build',worker,b,x,y}, " +
    "{t:'queueProduction',building,u,alt?}, {t:'cancelProduction',building,i}, " +
    "{t:'setRally',building,x,y} (where a producer's new units walk to — set it before a fight " +
    "rather than moving each spawn by hand), {t:'researchTech',building,tech}. " +
    "Workers cannot attack: use {t:'build',...}/{t:'gather',...} for them. " +
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
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
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
        const detail = result.reason ? `${result.code} (${result.reason})` : result.code;
        return {
          content: [{ type: "text", text: `Command rejected: ${detail}` }],
          isError: true,
          structuredContent: { code: result.code, ...(result.reason ? { reason: result.reason } : {}) },
        };
      }),
    },
    {
      // T-059a (FR-8): the real network trigger for engine/victory.js's own surrender() — a
      // seat-level concession, never a WireCommand (no ids, no ownership/fog/affordability to
      // check, no INPUT_DELAY_TICKS scheduling — none of issue_command's own codec applies to
      // "I am ending my own participation"), so this is its own tool rather than a new `t` on
      // COMMAND_SCHEMA's union.
      name: "surrender",
      title: "Surrender the match",
      description:
        "Voluntarily ends the calling seat's own participation in a live match — the same " +
        "concession a human player's in-match surrender action performs. Irreversible: once sent, " +
        "this seat is eliminated and cannot rejoin this match. Not instant: engine/victory.js's " +
        "own surrender only marks the seat eliminated, so the match's own over/winner/winReason " +
        "resolve on the very next tick, not this call — check get_situation or wait_for_event " +
        "afterward to see the outcome. Before a match has started, use leave_match instead.",
      inputSchema: {
        type: "object",
        properties: { seat_handle: { type: "string" } },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, async ({ seat }) => {
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
        const bridge = getBridge(seat.matchId);
        if (!bridge) return rejection("match-not-live: this match hasn't started yet — leave_match instead");
        // Take the seat back from the scripted AI first, if a set_seat_controller handover left it
        // there: server/matchWorker.js's own surrender handler deliberately ignores a request for a
        // seat a controller is driving (a scripted AI has no MCP handle to send one from, so such a
        // message could only be stray), which would otherwise make "hand my seat to the AI, then
        // concede" silently do nothing. A no-op for a seat that was never handed over.
        if (bridge.setSeatAi) await bridge.setSeatAi(seat.owner, false);
        bridge.surrender(seat.owner);
        return { content: [{ type: "text", text: "Surrendered. Your participation in this match has ended." }] };
      }),
    },
    {
      // The explicit handover an MCP client needs and a browser client does not. A human's browser
      // holds a live WebSocket, so the server can SEE them step away (the socket closes) and hand
      // their seat to the game's own AI after a grace period, handing it straight back when they
      // reconnect (server/matchWorker.js's seatDisconnected/seatConnected). An MCP client has no
      // such socket — it speaks in one-shot tool calls, and going quiet for two minutes to compact
      // its context is indistinguishable from thinking hard. So it says so instead: this is the
      // same one-line controller swap on the same slot, just requested rather than inferred.
      name: "set_seat_controller",
      title: "Hand your seat to the AI, or take it back",
      description:
        "Decides who drives YOUR seat right now. controller:'ai' hands it to one of the game's own " +
        "built-in opponents (optionally naming ai_strategy/difficulty) — do this before any pause " +
        "long enough to matter (compacting your context, a restart, a long think) so your base keeps " +
        "building and defending itself instead of standing still while the match runs on. " +
        "controller:'self' takes it back, and your commands work again immediately. Reversible as " +
        "often as you like, and your seat_handle and client_id stay valid throughout — this is not " +
        "leaving the match. Whatever the AI did while it held the seat stands; call get_situation " +
        "when you return rather than assuming the position you left.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          controller: { type: "string", enum: ["ai", "self"], description: "'ai' = the game's own AI plays this seat until further notice; 'self' = you are playing it again." },
          ai_strategy: { type: "string", description: "Only with controller:'ai' — which built-in strategy it should play (default, aggressive, economic, matching). Unknown names fall back to the default." },
          difficulty: { type: "string", description: "Only with controller:'ai' — easy, medium or hard." },
        },
        required: ["seat_handle", "controller"],
      },
      handler: withSeat(lobby, async ({ seat, controller, ai_strategy, difficulty }) => {
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
        if (controller !== "ai" && controller !== "self") return rejection("bad-controller: use 'ai' or 'self'");
        const bridge = getBridge(seat.matchId);
        if (!bridge) return rejection("match-not-live: this match hasn't started yet");
        if (!bridge.setSeatAi) return rejection("handover-unsupported: this match's server cannot swap a seat's controller");
        const wantAi = controller === "ai";
        const { ai } = await bridge.setSeatAi(seat.owner, wantAi, {
          ...(ai_strategy ? { strategy: ai_strategy } : {}),
          ...(difficulty ? { difficulty } : {}),
        });
        return {
          content: [{ type: "text", text: ai
            ? "The game's AI is playing your seat now. Call set_seat_controller with controller:'self' when you are ready to play again."
            : "You are driving your seat again. Call get_situation before acting — the position may have moved on." }],
          structuredContent: { controller: ai ? "ai" : "self", owner: seat.owner, ai_controlled: ai },
        };
      }),
    },
  ];
}
