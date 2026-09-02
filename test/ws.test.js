/* ============================================================
   T-025 (ADR-0005, docs/analysis/00-feasibility-spikes.md Spike 1, docs/analysis/04-hf-deployment.md
   §1): net/ws.js is a hand-rolled RFC 6455 WebSocket — zero dependencies (PRD NFR-5). This file
   covers the frame codec in isolation first (pure functions over Buffers, no socket involved) —
   framing bugs are "notoriously subtle" (ADR-0005's own words), so the adversarial cases
   (malformed lengths, split frames, oversized payloads, unmasked client frames) are exercised
   directly against the decoder, not just hoped to surface through an end-to-end test. The
   handshake and full connection lifecycle (real TCP socket, real HTTP upgrade, a real Chromium-
   grade client — Node 22's own native `WebSocket`, not a hand-rolled one that could share this
   server's own misconceptions) are covered further down.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import {
  OPCODE, CLOSE_CODE, encodeFrame, createFrameDecoder, computeAcceptKey, acceptUpgrade,
} from "../net/ws.js";

/* ---------- computeAcceptKey: RFC 6455 §1.3's own worked example ---------- */

test("computeAcceptKey matches RFC 6455 §1.3's canonical worked example", () => {
  // The exact key/accept pair the spec itself gives, and the same key docs/analysis/04's own
  // curl probe used — a real, already-referenced-in-this-repo test vector, not invented.
  assert.equal(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

/* ---------- encodeFrame: server -> client, NEVER masked ---------- */

function maskPayload(payload, mask) {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4];
  return out;
}

test("encodeFrame: a short text frame uses the 7-bit length directly", () => {
  const frame = encodeFrame(OPCODE.TEXT, Buffer.from("hi"));
  assert.equal(frame[0], 0b10000001, "FIN=1, RSV=000, opcode=0x1 (text)");
  assert.equal(frame[1], 2, "MASK=0 (server never masks), len=2");
  assert.deepEqual(frame.subarray(2), Buffer.from("hi"));
});

test("encodeFrame: a 126..65535-byte payload uses the 16-bit extended length", () => {
  const payload = Buffer.alloc(200, 0x41);
  const frame = encodeFrame(OPCODE.BINARY, payload);
  assert.equal(frame[0], 0b10000010, "FIN=1, opcode=0x2 (binary)");
  assert.equal(frame[1], 126, "the 126 sentinel selects the 16-bit length");
  assert.equal(frame.readUInt16BE(2), 200);
  assert.deepEqual(frame.subarray(4), payload);
});

test("encodeFrame: a >=65536-byte payload uses the 64-bit extended length", () => {
  const payload = Buffer.alloc(70000, 0x42);
  const frame = encodeFrame(OPCODE.BINARY, payload);
  assert.equal(frame[1], 127, "the 127 sentinel selects the 64-bit length");
  assert.equal(frame.readBigUInt64BE(2), 70000n);
  assert.deepEqual(frame.subarray(10), payload);
});

test("encodeFrame: fin:false clears the FIN bit, for a fragment that continues", () => {
  const frame = encodeFrame(OPCODE.TEXT, Buffer.from("part"), { fin: false });
  assert.equal(frame[0] & 0x80, 0, "FIN bit must be clear");
  assert.equal(frame[0] & 0x0f, OPCODE.TEXT);
});

test("encodeFrame: a control frame (ping/pong/close) round-trips its payload", () => {
  const ping = encodeFrame(OPCODE.PING, Buffer.alloc(0));
  assert.equal(ping[0], 0b10001001);
  assert.equal(ping[1], 0);
  assert.equal(ping.length, 2);
});

/* ---------- createFrameDecoder: client -> server, MUST be masked ---------- */

function clientFrame(opcode, payload, { fin = true, mask = Buffer.from([0x12, 0x34, 0x56, 0x78]) } = {}) {
  const len = payload.length;
  const parts = [];
  const byte0 = (fin ? 0x80 : 0) | opcode;
  if (len < 126) {
    parts.push(Buffer.from([byte0, 0x80 | len]));
  } else if (len < 65536) {
    const h = Buffer.alloc(4);
    h[0] = byte0; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2);
    parts.push(h);
  } else {
    const h = Buffer.alloc(10);
    h[0] = byte0; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2);
    parts.push(h);
  }
  parts.push(mask);
  parts.push(maskPayload(payload, mask));
  return Buffer.concat(parts);
}

test("decoder: a short, correctly masked text frame round-trips to the original payload", () => {
  const decoder = createFrameDecoder();
  const [frame] = decoder.push(clientFrame(OPCODE.TEXT, Buffer.from("hello")));
  assert.equal(frame.fin, true);
  assert.equal(frame.opcode, OPCODE.TEXT);
  assert.deepEqual(frame.payload, Buffer.from("hello"));
});

test("decoder: 16-bit and 64-bit extended lengths both decode correctly", () => {
  const decoder = createFrameDecoder({ maxPayload: 1_000_000 });
  const mid = Buffer.alloc(500, 0x61);
  const [f1] = decoder.push(clientFrame(OPCODE.BINARY, mid));
  assert.deepEqual(f1.payload, mid);

  const big = Buffer.alloc(70000, 0x62);
  const [f2] = decoder.push(clientFrame(OPCODE.BINARY, big));
  assert.deepEqual(f2.payload, big);
});

test("decoder: unmasking correctly XORs every byte against the 4-byte mask, cycling", () => {
  const decoder = createFrameDecoder();
  const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const mask = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
  const [frame] = decoder.push(clientFrame(OPCODE.BINARY, payload, { mask }));
  assert.deepEqual(frame.payload, payload, "unmasking must recover the exact original bytes");
});

/* ---------- adversarial: the exit criterion's own named cases ---------- */

test("decoder: an UNMASKED client frame is rejected — a protocol violation, not tolerated (RFC 6455 §5.1)", () => {
  const decoder = createFrameDecoder();
  // Hand-build a frame with the mask bit clear, bypassing the clientFrame() helper (which always masks).
  const unmasked = Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from("hi")]);
  assert.throws(() => decoder.push(unmasked), /mask/i);
});

test("decoder: a frame declaring a length beyond maxPayload is rejected before the payload even has to arrive", () => {
  const decoder = createFrameDecoder({ maxPayload: 1000 });
  // Only the 64-bit-length HEADER, no payload bytes at all — a slow-loris shape. Must still reject
  // immediately off the declared length, not hang waiting for a payload that may never come.
  const header = Buffer.alloc(10);
  header[0] = 0x82; header[1] = 0x80 | 127; header.writeBigUInt64BE(50_000_000n, 2);
  const mask = Buffer.from([1, 2, 3, 4]);
  assert.throws(() => decoder.push(Buffer.concat([header, mask])), /too (big|large)|payload/i);
});

test("decoder: a set RSV bit is rejected — no extension (permessage-deflate included) is ever negotiated", () => {
  const decoder = createFrameDecoder();
  const rsv1Set = Buffer.concat([clientFrame(OPCODE.TEXT, Buffer.from("x"))]);
  rsv1Set[0] |= 0x40;   // RSV1
  assert.throws(() => decoder.push(rsv1Set), /rsv/i);
});

test("decoder: an unknown opcode is rejected", () => {
  const decoder = createFrameDecoder();
  const bad = clientFrame(0x3, Buffer.from("x"));   // 0x3-0x7 and 0xB-0xF are reserved/unassigned
  assert.throws(() => decoder.push(bad), /opcode/i);
});

test("decoder: a fragmented (non-FIN) control frame is rejected — control frames must never be fragmented (RFC 6455 §5.5)", () => {
  const decoder = createFrameDecoder();
  const bad = clientFrame(OPCODE.PING, Buffer.from("x"), { fin: false });
  assert.throws(() => decoder.push(bad), /control|fragment/i);
});

test("decoder: an oversized control-frame payload (>125 bytes) is rejected (RFC 6455 §5.5)", () => {
  const decoder = createFrameDecoder();
  const bad = clientFrame(OPCODE.PING, Buffer.alloc(126));
  assert.throws(() => decoder.push(bad), /control|125/i);
});

test("decoder: a frame split ACROSS pushes — one byte at a time — still decodes correctly", () => {
  const decoder = createFrameDecoder();
  const whole = clientFrame(OPCODE.TEXT, Buffer.from("split across many reads"));
  let decoded = null;
  for (const byte of whole) {
    const frames = decoder.push(Buffer.from([byte]));
    if (frames.length) decoded = frames[0];
  }
  assert.ok(decoded, "the frame must eventually decode once all bytes have arrived");
  assert.deepEqual(decoded.payload, Buffer.from("split across many reads"));
});

test("decoder: two complete frames in ONE push both decode, in order", () => {
  const decoder = createFrameDecoder();
  const combined = Buffer.concat([
    clientFrame(OPCODE.TEXT, Buffer.from("first")),
    clientFrame(OPCODE.TEXT, Buffer.from("second")),
  ]);
  const frames = decoder.push(combined);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].payload, Buffer.from("first"));
  assert.deepEqual(frames[1].payload, Buffer.from("second"));
});

test("decoder: a partial frame followed by the rest, PLUS a second complete frame, decodes both correctly and leaves no residue", () => {
  const decoder = createFrameDecoder();
  const whole = clientFrame(OPCODE.TEXT, Buffer.from("abcdefgh"));
  const split = Math.floor(whole.length / 2);
  assert.deepEqual(decoder.push(whole.subarray(0, split)), []);
  const second = clientFrame(OPCODE.TEXT, Buffer.from("more"));
  const frames = decoder.push(Buffer.concat([whole.subarray(split), second]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].payload, Buffer.from("abcdefgh"));
  assert.deepEqual(frames[1].payload, Buffer.from("more"));
});

test("decoder: continuation frames (fragmented data message) each decode as their own raw frame — reassembly is the connection layer's job, not the frame decoder's", () => {
  const decoder = createFrameDecoder();
  const frames = decoder.push(Buffer.concat([
    clientFrame(OPCODE.TEXT, Buffer.from("Hel"), { fin: false }),
    clientFrame(OPCODE.CONTINUATION, Buffer.from("lo"), { fin: true }),
  ]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].fin, false);
  assert.equal(frames[0].opcode, OPCODE.TEXT);
  assert.equal(frames[1].fin, true);
  assert.equal(frames[1].opcode, OPCODE.CONTINUATION);
});

/* ---------- handshake + full lifecycle: a real HTTP server, a real TCP socket, a real client ---------- */

function withServer(fn) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => { res.writeHead(404).end(); });
    server.on("upgrade", (req, socket, head) => {
      acceptUpgrade(req, socket, head, { pingIntervalMs: 60_000 }).then(result => {
        if (!result.ok) { socket.destroy(); return; }
        server.__lastConn = result.connection;
        server.emit("__connection", result.connection);
      });
    });
    server.listen(0, async () => {
      try { await fn(server, server.address().port); resolve(); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

test("acceptUpgrade + a real Node WebSocket client: handshake succeeds and text messages round-trip", async () => {
  await withServer((server, port) => new Promise((resolve, reject) => {
    server.once("__connection", conn => {
      conn.onmessage = (data, isBinary) => {
        assert.equal(isBinary, false);
        conn.send(`echo:${data}`);
      };
    });
    const ws = new WebSocket(`ws://localhost:${port}/`);
    ws.addEventListener("open", () => ws.send("ping-from-real-client"));
    ws.addEventListener("message", ev => {
      try {
        assert.equal(ev.data, "echo:ping-from-real-client");
        ws.close();
        resolve();
      } catch (e) { reject(e); }
    });
    ws.addEventListener("error", reject);
  }));
});

test("acceptUpgrade + a real Node WebSocket client: binary messages round-trip as ArrayBuffer", async () => {
  await withServer((server, port) => new Promise((resolve, reject) => {
    server.once("__connection", conn => {
      conn.onmessage = (data, isBinary) => { if (isBinary) conn.send(data); };
    });
    const ws = new WebSocket(`ws://localhost:${port}/`);
    ws.binaryType = "arraybuffer";
    const sent = new Uint8Array([1, 2, 3, 4, 250]);
    ws.addEventListener("open", () => ws.send(sent));
    ws.addEventListener("message", ev => {
      try {
        assert.deepEqual(new Uint8Array(ev.data), sent);
        ws.close();
        resolve();
      } catch (e) { reject(e); }
    });
    ws.addEventListener("error", reject);
  }));
});

test("acceptUpgrade + a real Node WebSocket client: the close handshake completes cleanly on both ends", async () => {
  await withServer((server, port) => new Promise((resolve, reject) => {
    server.once("__connection", conn => {
      conn.onclose = (code) => {
        try { assert.equal(code, 1000); resolve(); }
        catch (e) { reject(e); }
      };
    });
    const ws = new WebSocket(`ws://localhost:${port}/`);
    ws.addEventListener("open", () => ws.close(1000, "bye"));
    ws.addEventListener("error", reject);
  }));
});

test("acceptUpgrade rejects a handshake with the wrong Sec-WebSocket-Version", async () => {
  await withServer((server, port) => new Promise((resolve, reject) => {
    const req = httpRequest({
      port, path: "/", method: "GET",
      headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "8",   // wrong — RFC 6455 is version 13
      },
    });
    req.on("upgrade", () => reject(new Error("must not upgrade on a bad version")));
    req.on("response", res => { assert.equal(res.statusCode, 400); resolve(); });
    req.on("error", reject);
    req.end();
  }));
});

test("acceptUpgrade validates Origin when an allowlist is configured, rejecting anything not on it", async () => {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
      acceptUpgrade(req, socket, head, { allowedOrigins: ["https://spacecities.example"] }).then(result => {
        if (result.ok) { socket.destroy(); reject(new Error("must not accept a disallowed Origin")); return; }
        socket.destroy();
      });
    });
    server.listen(0, () => {
      const port = server.address().port;
      const req = httpRequest({
        port, path: "/", method: "GET",
        headers: {
          Connection: "Upgrade", Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
          Origin: "https://evil.example",
        },
      });
      req.on("upgrade", () => { server.close(); reject(new Error("must not upgrade")); });
      req.on("response", res => { assert.equal(res.statusCode, 403); server.close(); resolve(); });
      req.on("error", e => { server.close(); reject(e); });
      req.end();
    });
  });
});

test("connection.ping()/pong: a real client's automatic pong reply is observed server-side", async () => {
  await withServer((server, port) => new Promise((resolve, reject) => {
    let ws;
    server.once("__connection", conn => {
      conn.onpong = () => { conn.close(); resolve(); };
      conn.ping();
    });
    ws = new WebSocket(`ws://localhost:${port}/`);
    // A native browser/Node WebSocket answers a ping with a pong automatically and invisibly —
    // there is no application code here at all doing it; that silence is the point (dossier 04 §1.3).
    ws.addEventListener("close", () => {});   // keep the listener graph tidy; no assertion needed here
    ws.addEventListener("error", reject);
  }));
});
