/* ============================================================
   net/ws.js — a hand-rolled RFC 6455 WebSocket server, zero dependencies (ADR-0005; PRD NFR-5
   forbids npm packages in the shipped image, and Node ships no WebSocket SERVER — only a client).
   Built on `node:http` + `node:crypto` alone, exactly as docs/analysis/00-feasibility-spikes.md's
   Spike 1 proved practical (a real Chromium `WebSocket` round-tripped against ~90 lines) and
   docs/analysis/04-hf-deployment.md §1 measured live through the Hugging Face edge before this
   was ever relied on: WebSockets work, 20 Hz is comfortable (0% loss, p50 RTT 32.6 ms), frames up
   to ~16 MB traverse cleanly, and a ~20 s server-side ping keeps a connection alive indefinitely
   (verified 10+ minutes fully idle) — the edge publishes no idle-timeout figure, so the ping isn't
   optional insurance, it's the only reason "idle survives" is true at all.

   SCOPE (T-025). The wire protocol only: handshake, frame codec (both directions), fragmentation,
   ping/pong keep-alive, the close handshake, Origin validation, and payload-size limits as a DoS
   guard. This file knows nothing about game state, seats, or the Transport interface — wrapping a
   connection object in ADR-0004's Transport shape (submitCommand/onEvent/close) is T-026's job,
   layered on top, the same "layer, don't conflate" split every other net/ file in this port uses
   (net/commandEnvelope.js knows shape, not ownership; net/commandCodec.js knows ownership, not
   scheduling; server/matchLoop.js knows scheduling, not persistence). Declining `permessage-
   deflate` (ADR-0005's own decision — small JSON payloads, compression buys little and costs a
   whole failure surface) means simply never advertising it in the 101 response; nothing here
   negotiates it at all.

   WHY A RAW FRAME DECODER RETURNS FRAMES, NOT REASSEMBLED MESSAGES. RFC 6455 §5.4 lets a control
   frame (ping/pong/close) interleave BETWEEN the fragments of an in-progress data message. Message
   reassembly is therefore a stateful, opcode-aware concern that belongs one layer up, in the
   connection object below — createFrameDecoder itself stays a pure, small, independently
   adversarial-testable boundary: bytes in, frames out, protocol violations thrown.
   ============================================================ */

"use strict";

import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2,
  CLOSE: 0x8, PING: 0x9, PONG: 0xa,
});
const CONTROL_OPCODES = new Set([OPCODE.CLOSE, OPCODE.PING, OPCODE.PONG]);
const KNOWN_OPCODES = new Set([OPCODE.CONTINUATION, OPCODE.TEXT, OPCODE.BINARY, ...CONTROL_OPCODES]);

export const CLOSE_CODE = Object.freeze({
  NORMAL: 1000, GOING_AWAY: 1001, PROTOCOL_ERROR: 1002, UNSUPPORTED_DATA: 1003,
  // 1006 (ABNORMAL) is RFC 6455 §7.4.1's own reserved code for exactly this situation: it must
  // NEVER be sent ON THE WIRE in a real close frame, but IS the correct value to report to an API
  // consumer when the connection ended with no close frame at all (T-029b — see the raw-socket
  // "close" handler below, the one path that can report it).
  ABNORMAL: 1006,
  INVALID_PAYLOAD: 1007, POLICY_VIOLATION: 1008, MESSAGE_TOO_BIG: 1009, INTERNAL_ERROR: 1011,
});

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";   // RFC 6455 §1.3, fixed by the spec

/** RFC 6455 §1.3: base64(SHA-1(client key + the magic GUID above)). Verified against the spec's
 *  own worked example (test/ws.test.js) — the same key docs/analysis/04's curl probe used. */
export function computeAcceptKey(clientKey) {
  return createHash("sha1").update(clientKey + WS_MAGIC, "binary").digest("base64");
}

/* ---------- frame codec ---------- */

/**
 * Server -> client. A server MUST NOT mask its own frames (RFC 6455 §5.1).
 * @param {number} opcode @param {Buffer} payload @param {{fin?: boolean}} [opts]
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true } = {}) {
  const len = payload.length;
  const byte0 = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let header;
  if (len < 126) {
    header = Buffer.from([byte0, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = byte0; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = byte0; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function protocolError(msg) {
  const e = new Error(msg);
  e.code = "WS_PROTOCOL_ERROR";
  return e;
}

/**
 * A streaming client -> server frame decoder: feed raw TCP bytes to push(chunk) as they arrive,
 * in whatever pieces the network happens to deliver them (RFC 6455 places zero structure
 * requirements on read boundaries — a header can arrive one byte at a time, and one chunk can
 * hold several whole frames back to back). Returns every COMPLETE raw frame push() found in the
 * combined buffer, oldest first; partial data is retained internally for the next call. Throws a
 * WS_PROTOCOL_ERROR on anything RFC 6455 requires the server to refuse — unmasked client frames
 * (§5.1), a set RSV bit (§5.2 — no extension is ever negotiated here), an unknown opcode, a
 * payload beyond `maxPayload` (checked off the DECLARED length, before waiting for that much data
 * to actually arrive — the slow-loris shape), or a fragmented/oversized control frame (§5.5).
 * @param {{maxPayload?: number}} [opts]
 */
export function createFrameDecoder({ maxPayload = 1 << 20 } = {}) {
  let buf = Buffer.alloc(0);

  function tryParseOne() {
    if (buf.length < 2) return null;
    const byte0 = buf[0], byte1 = buf[1];
    const fin = !!(byte0 & 0x80);
    const rsv = byte0 & 0x70;
    const opcode = byte0 & 0x0f;
    const masked = !!(byte1 & 0x80);
    let len = byte1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) throw protocolError("RSV bit set — no extension is negotiated");
    if (!KNOWN_OPCODES.has(opcode)) throw protocolError(`unknown opcode 0x${opcode.toString(16)}`);
    if (!masked) throw protocolError("client frame missing the required mask (RFC 6455 §5.1)");

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset); offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset); offset += 8;
      if (big > BigInt(maxPayload)) throw protocolError(`payload too big (${big} > ${maxPayload})`);
      len = Number(big);
    }
    if (len > maxPayload) throw protocolError(`payload too big (${len} > ${maxPayload})`);
    if (CONTROL_OPCODES.has(opcode)) {
      if (!fin) throw protocolError("control frames must never be fragmented (RFC 6455 §5.5)");
      if (len > 125) throw protocolError("control frame payload exceeds 125 bytes (RFC 6455 §5.5)");
    }

    const maskStart = offset;
    offset += 4;
    const payloadStart = offset;
    const total = offset + len;
    if (buf.length < total) return null;   // header (+ mask) complete, payload still incoming

    const mask = buf.subarray(maskStart, maskStart + 4);
    const raw = buf.subarray(payloadStart, total);
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3];

    if (opcode === OPCODE.TEXT && fin && !isUtf8(payload)) {
      throw protocolError("text frame payload is not valid UTF-8 (RFC 6455 §8.1)");
    }

    buf = buf.subarray(total);
    return { fin, opcode, payload };
  }

  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      const frames = [];
      let frame;
      while ((frame = tryParseOne())) frames.push(frame);
      return frames;
    },
  };
}

/* ---------- handshake ---------- */

function rejectUpgrade(socket, statusCode, statusText) {
  const body = statusText;
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    );
  } catch { /* socket already gone — nothing left to tell the client */ }
  socket.end();
  return { ok: false, statusCode, reason: statusText };
}

/**
 * Handle one HTTP `upgrade` event. Validates the handshake (version, key, optionally Origin),
 * writes the 101 response with no extensions offered (declining permessage-deflate), and returns
 * a live connection object wrapping `socket`. Rejects with a plain HTTP error response — never a
 * silent socket drop — on anything invalid, so a misbehaving client gets a diagnosable status
 * code instead of a hung connection.
 * @param {import("http").IncomingMessage} req
 * @param {import("net").Socket} socket
 * @param {Buffer} head - bytes already read past the handshake by Node's own HTTP parser; RFC 6455
 *   requires none be lost, so any that exist are the connection's first, pre-buffered frame data.
 * @param {Object} [opts]
 * @param {string[]} [opts.allowedOrigins] - when given, the Origin header must be in this list
 * @param {number} [opts.pingIntervalMs=22500] - dossier 04 §1.3's measured-safe 20-25s window
 * @param {number} [opts.maxPayload=1<<20] - 1 MiB; ours to choose (dossier 04 §1.4 — the HF edge
 *   itself carries frames to ~16 MB with no complaint)
 * @returns {Promise<{ok:true, connection:Object}|{ok:false, statusCode:number, reason:string}>}
 */
export async function acceptUpgrade(req, socket, head, opts = {}) {
  const { allowedOrigins, pingIntervalMs = 22_500, maxPayload = 1 << 20 } = opts;

  if ((req.headers.upgrade || "").toLowerCase() !== "websocket") return rejectUpgrade(socket, 400, "Bad Request");
  if (req.headers["sec-websocket-version"] !== "13") return rejectUpgrade(socket, 400, "Bad Request");
  const clientKey = req.headers["sec-websocket-key"];
  if (typeof clientKey !== "string" || !clientKey) return rejectUpgrade(socket, 400, "Bad Request");
  if (allowedOrigins && !allowedOrigins.includes(req.headers.origin)) return rejectUpgrade(socket, 403, "Forbidden");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${computeAcceptKey(clientKey)}\r\n` +
    "\r\n"
  );

  const connection = createConnection(socket, { pingIntervalMs, maxPayload });
  if (head && head.length) connection._feed(head);
  return { ok: true, connection };
}

/* ---------- connection: frames <-> messages, keep-alive, close handshake ---------- */

function closeCodeBuffer(code) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(code, 0);
  return b;
}

function createConnection(socket, { pingIntervalMs, maxPayload }) {
  const decoder = createFrameDecoder({ maxPayload });
  let closed = false;
  let fragment = null;   // { opcode, chunks } while a fragmented data message is in progress

  const conn = {
    onmessage: null,   // (data: string|Buffer, isBinary: boolean) => void
    onclose: null,     // (code: number, reason: string) => void
    onerror: null,      // (err: Error) => void
    onpong: null,       // (payload: Buffer) => void

    send(data) {
      if (closed) return;
      const isBinary = Buffer.isBuffer(data) || data instanceof Uint8Array;
      const payload = isBinary ? Buffer.from(data) : Buffer.from(String(data), "utf8");
      socket.write(encodeFrame(isBinary ? OPCODE.BINARY : OPCODE.TEXT, payload));
    },
    ping(payload = Buffer.alloc(0)) {
      if (!closed) socket.write(encodeFrame(OPCODE.PING, payload));
    },
    close(code = CLOSE_CODE.NORMAL, reason = "") {
      if (closed) return;
      closed = true;
      stopPing();
      try { socket.write(encodeFrame(OPCODE.CLOSE, Buffer.concat([closeCodeBuffer(code), Buffer.from(reason, "utf8")]))); }
      catch { /* socket already unusable — nothing to flush */ }
      socket.end();
    },
    // Test/internal seam for `head` (RFC 6455: bytes the HTTP parser already read past the
    // handshake belong to the connection, not the void) — never called by real client traffic,
    // which always arrives through the socket's own 'data' event below.
    _feed(chunk) { onData(chunk); },
  };

  function stopPing() {
    clearInterval(pingTimer);
  }

  function abort(code, reason, err) {
    if (err) conn.onerror?.(err);
    if (closed) return;
    closed = true;
    stopPing();
    try { socket.write(encodeFrame(OPCODE.CLOSE, closeCodeBuffer(code))); } catch { /* ignore */ }
    socket.end();
    conn.onclose?.(code, reason);
  }

  function deliver(opcode, payload) {
    conn.onmessage?.(opcode === OPCODE.BINARY ? payload : payload.toString("utf8"), opcode === OPCODE.BINARY);
  }

  function handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.PING:
        socket.write(encodeFrame(OPCODE.PONG, frame.payload));
        return;
      case OPCODE.PONG:
        conn.onpong?.(frame.payload);
        return;
      case OPCODE.CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : CLOSE_CODE.NORMAL;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : "";
        const alreadyClosing = closed;
        closed = true;
        stopPing();
        if (!alreadyClosing) {
          try { socket.write(encodeFrame(OPCODE.CLOSE, frame.payload.subarray(0, 2))); } catch { /* ignore */ }
        }
        socket.end();
        conn.onclose?.(code, reason);
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (fragment) { abort(CLOSE_CODE.PROTOCOL_ERROR, "", protocolError("new data frame while a fragmented message is still open")); return; }
        if (frame.fin) deliver(frame.opcode, frame.payload);
        else fragment = { opcode: frame.opcode, chunks: [frame.payload] };
        return;
      case OPCODE.CONTINUATION:
        if (!fragment) { abort(CLOSE_CODE.PROTOCOL_ERROR, "", protocolError("continuation frame with no fragmented message open")); return; }
        fragment.chunks.push(frame.payload);
        if (frame.fin) {
          const { opcode, chunks } = fragment;
          fragment = null;
          const full = Buffer.concat(chunks);
          if (opcode === OPCODE.TEXT && !isUtf8(full)) {
            abort(CLOSE_CODE.INVALID_PAYLOAD, "", protocolError("reassembled text message is not valid UTF-8"));
            return;
          }
          deliver(opcode, full);
        }
        return;
    }
  }

  function onData(chunk) {
    let frames;
    try { frames = decoder.push(chunk); }
    catch (e) { abort(CLOSE_CODE.PROTOCOL_ERROR, "", e); return; }
    for (const frame of frames) {
      if (closed) return;   // a prior frame in this same batch already ended the connection
      handleFrame(frame);
    }
  }

  socket.on("data", onData);
  socket.on("error", e => { stopPing(); conn.onerror?.(e); });
  // T-029b: the raw TCP socket ending is the ONLY event that fires unconditionally, whatever
  // caused it — a clean close handshake (OPCODE.CLOSE above) or abort() both already call
  // socket.end(), which lands here too once the OS finishes the shutdown, but ALSO an abrupt
  // death with no close frame at all (a killed/crashed process, a dropped network path) — the
  // realistic shape a server restart or a real network failure actually takes, not a graceful
  // handshake. `closed` is already set true by whichever of those paths got there first, so this
  // only ever reports onclose itself for the abrupt case that no other path already handled —
  // never a double-fire on top of a clean close or an abort().
  socket.on("close", () => {
    stopPing();
    if (!closed) { closed = true; conn.onclose?.(CLOSE_CODE.ABNORMAL, ""); }
  });

  // ~20-25s, per dossier 04 §1.3's own measurement: a real 10+ minute idle survival needs a ping
  // in that window, and this is a real RFC 6455 ping frame (opcode 0x9), not an app-level nudge —
  // Node's client-side WebSocket answers it with a pong automatically, with no application code
  // able to intercept or skip that step.
  const pingTimer = setInterval(() => conn.ping(), pingIntervalMs);
  pingTimer.unref?.();   // a keep-alive timer must never be the reason the process stays alive

  return conn;
}
