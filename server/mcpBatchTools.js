/* ============================================================
   server/mcpBatchTools.js — `batch`, one MCP tool call that runs a SEQUENCE of this server's own
   tool calls.

   WHY THIS EXISTS, given issue_command already batches. Two different batchings, at two different
   layers, and only one of them existed:

     - {t:"batch", c:[...]} (net/commandShapes.js) batches COMMANDS INSIDE ONE TICK — up to 16
       orders applied together by the sim. That is a game-rules mechanism, and it stays exactly as
       it is.
     - THIS batches ROUND TRIPS. A turn an agent actually plays is rarely one command: it is "look
       at the situation, look at my idle workers, send them mining, queue a unit, then wait for
       something to happen" — five HTTP requests, five model turns, five chances for the position
       to move underneath it. Over a 20Hz real-time match that latency is the single largest thing
       standing between an MCP client and a browser client, and no command-level batching can
       shorten it, because the calls are not all commands.

   So this is deliberately a batch of TOOL CALLS, not of commands: any registered tool, in any
   order, observation and action mixed freely (read the situation, act on it, then wait — in one
   request). It adds no capability of its own and bypasses nothing — every step runs through the
   very same registered handler a direct tools/call would reach, so the APM ceiling, the seat
   resolution, the codec's ownership/fog checks and every rejection code all apply identically,
   once per step. A batch of 10 issue_commands spends 10 APM, exactly as 10 separate calls would.

   `seat_handle` is filled in per step from the batch's own top-level one when a step omits it,
   which is what makes a batch read like a turn rather than like ten copies of the same 300-byte
   credential. A step MAY name a different handle (watching two matches at once); nothing stops it,
   because nothing needs to — each step authenticates itself exactly as it would alone.

   ERROR POLICY. A step that fails is reported in place, with the same isError/content/
   structuredContent the single call would have produced, and — by default — the batch STOPS
   there. That default is the safe one for the thing this is actually for: a turn whose steps
   depend on each other ("build a refinery, then rally to it") should not keep executing after the
   step it was building on was rejected. Pass continue_on_error:true for an independent sweep.
   The whole batch is always a SUCCESSFUL tool result (never isError at the top level) — "step 3
   was rejected" is data the agent needs to read and act on, and marking the envelope itself failed
   would hide steps 1, 2 and 4 behind it.

   NOT A TRANSACTION. Steps run in order and nothing rolls back: this is latency amortization, not
   atomicity. The sim keeps ticking between steps (a batch containing a wait_for_event is doing
   exactly that on purpose), so a later step sees a world the earlier ones have already moved.
   ============================================================ */

"use strict";

// A generous cap, not a tuning parameter: the point is to bound one request's work, not to shape
// how an agent plays. Well above a realistic turn (a handful of observations and orders) and well
// below anything that could hold a request open long enough to matter.
const MAX_STEPS = 24;

/**
 * @param {() => Array<{name:string, handler:(args:Object)=>(Object|Promise<Object>)}>} getTools
 *   the server's own registered tool list, resolved LAZILY — this tool is itself one of the tools
 *   in that list, so it cannot close over a finished array at construction time without either a
 *   cycle or a stale snapshot that silently misses every tool registered after it.
 */
export function createBatchTools(getTools) {
  return [
    {
      name: "batch",
      title: "Run several tool calls in one request",
      description:
        "Runs a list of this server's own tool calls in order, in a single round trip — the way to " +
        "play a whole turn (look, decide, act, wait) without paying network latency five times over " +
        "while the match ticks on. Any tool can appear, in any order: observation and action mixed " +
        "freely. Each step omitting seat_handle inherits the batch's own. Every step goes through " +
        "the identical validation, rate limit and rejection codes it would as a separate call — " +
        "batching is cheaper, never more permissive. Steps are NOT atomic and nothing rolls back: " +
        "by default the batch stops at the first step that fails (so a dependent chain cannot run " +
        "on a broken premise); pass continue_on_error:true for independent steps. The result always " +
        "lists every step that ran, each with exactly the result that step would have returned alone.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string", description: "The default seat_handle (or watch_handle) for every step that does not name its own." },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: MAX_STEPS,
            description: `The calls to make, in order (max ${MAX_STEPS}).`,
            items: {
              type: "object",
              properties: {
                tool: { type: "string", description: "The tool name, e.g. get_situation or issue_command." },
                arguments: { type: "object", description: "That tool's own arguments. seat_handle may be omitted to inherit the batch's." },
              },
              required: ["tool"],
            },
          },
          continue_on_error: { type: "boolean", description: "Keep going after a step fails (default false: stop at the first failure)." },
        },
        required: ["steps"],
      },
      handler: async ({ seat_handle, steps, continue_on_error }) => {
        if (!Array.isArray(steps) || steps.length === 0) {
          return { content: [{ type: "text", text: "Could not complete: no-steps — `steps` must be a non-empty array." }], isError: true };
        }
        if (steps.length > MAX_STEPS) {
          return { content: [{ type: "text", text: `Could not complete: too-many-steps — at most ${MAX_STEPS} per batch, got ${steps.length}.` }], isError: true };
        }
        // Resolved per call, never cached: the registry is fixed for a server's lifetime in
        // practice, but looking it up here is what keeps this file independent of registration
        // order (see getTools' own doc).
        const byName = new Map(getTools().map(t => [t.name, t]));
        const results = [];
        let stopped_at = null;
        for (const [i, step] of steps.entries()) {
          const tool = byName.get(step?.tool);
          if (!tool) {
            // An unknown tool name inside a batch is a STEP failure, not a protocol error: the
            // batch request itself was well-formed, and steps that already ran must still be
            // reported rather than thrown away behind a -32602. (A direct tools/call with a bad
            // name is still a protocol error — that request really is malformed.)
            results.push({ step: i, tool: step?.tool ?? null, isError: true, content: [{ type: "text", text: `Could not complete: unknown-tool — no tool named ${JSON.stringify(step?.tool)}.` }] });
          } else if (tool.name === "batch") {
            // No nesting: a batch inside a batch multiplies the step cap it exists to enforce, and
            // buys nothing a flat list of the same steps does not already give.
            results.push({ step: i, tool: tool.name, isError: true, content: [{ type: "text", text: "Could not complete: no-nested-batch — list the steps directly instead." }] });
          } else {
            const args = { ...(seat_handle !== undefined ? { seat_handle } : {}), ...(step.arguments ?? {}) };
            let outcome;
            try {
              outcome = await tool.handler(args);
            } catch (e) {
              // A handler that throws would be a -32603 for a direct call and would abort the
              // whole request; inside a batch it becomes this step's own failure, so the steps
              // around it still report.
              outcome = { content: [{ type: "text", text: `Could not complete: tool-threw — ${e.message}` }], isError: true };
            }
            results.push({
              step: i, tool: tool.name,
              content: outcome.content ?? [],
              ...(outcome.isError ? { isError: true } : {}),
              ...(outcome.structuredContent !== undefined ? { structuredContent: outcome.structuredContent } : {}),
            });
          }
          if (results[results.length - 1].isError && !continue_on_error) {
            stopped_at = i;
            break;
          }
        }
        const failed = results.filter(r => r.isError).length;
        return {
          content: [{ type: "text", text: `Ran ${results.length} of ${steps.length} step(s), ${failed} failed${stopped_at !== null ? ` — stopped at step ${stopped_at}` : ""}.` }],
          structuredContent: { results, ran: results.length, requested: steps.length, failed, stopped_at },
        };
      },
    },
  ];
}
