/* ============================================================
   The shared contract every Transport implementation must satisfy — net/transport.js's own
   header promises this file, and names it by this exact path, since T-009: "the shared contract
   every implementation must satisfy lives in test/transportContract.js, not here." T-026 (a
   second real implementation alongside net/loopback.js) is what finally gives that promise a
   reason to exist: a contract is only worth writing down once there is more than one thing that
   has to honor it, and this is the file that proves net/loopback.js and net/wsClientTransport.js
   are genuinely interchangeable, not just superficially similar — T-026's own exit criterion,
   made executable instead of merely asserted.

   Deliberately narrow: only the properties net/transport.js's own JSDoc actually documents as
   universal (a submitCommand call resolves with a CommandResult; the same outcome is ALSO
   broadcast via onEvent; close is idempotent; a command submitted after close resolves with a
   clear rejection rather than throwing or hanging forever). Implementation-specific behavior —
   loopback's genuinely-synchronous-underneath guarantee, the WebSocket transport's welcome
   handshake — stays in each implementation's own test file, where it belongs.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * @param {string} label - identifies which implementation is under test, in every assertion message
 * @param {() => Promise<{transport: Transport, unitId: string, moveTarget: {x:number,y:number}, cleanup: () => void}>} setup
 *   Build one fresh transport plus a real, owned unit id it can issue a "move" command against —
 *   the one command shape simple enough that every implementation can supply a working fixture
 *   for it without the contract needing to know anything about match setup.
 */
export function testTransportContract(label, setup) {
  test(`[${label}] submitCommand resolves with an ok CommandResult for a valid command`, async () => {
    const { transport, unitId, moveTarget, cleanup } = await setup();
    try {
      const result = await transport.submitCommand({ t: "move", ids: [unitId], x: moveTarget.x, y: moveTarget.y });
      assert.equal(result.ok, true, `[${label}] a valid move must be accepted`);
    } finally { cleanup(); }
  });

  test(`[${label}] the same outcome is also broadcast via onEvent as a commandResult event`, async () => {
    const { transport, unitId, moveTarget, cleanup } = await setup();
    try {
      const events = [];
      transport.onEvent(e => events.push(e));
      const result = await transport.submitCommand({ t: "move", ids: [unitId], x: moveTarget.x, y: moveTarget.y });
      const seen = events.find(e => e.type === "commandResult");
      assert.ok(seen, `[${label}] a commandResult event must have been broadcast`);
      assert.deepEqual(seen.result, result, `[${label}] the broadcast result must match the resolved one`);
    } finally { cleanup(); }
  });

  test(`[${label}] close() is idempotent`, async () => {
    const { transport, cleanup } = await setup();
    try {
      transport.close();
      assert.doesNotThrow(() => transport.close());
    } finally { cleanup(); }
  });

  test(`[${label}] submitCommand after close resolves with a clear rejection, never throws or hangs`, async () => {
    const { transport, unitId, moveTarget, cleanup } = await setup();
    try {
      transport.close();
      const result = await transport.submitCommand({ t: "move", ids: [unitId], x: moveTarget.x, y: moveTarget.y });
      assert.equal(result.ok, false, `[${label}] a command submitted after close must not succeed`);
    } finally { cleanup(); }
  });
}
