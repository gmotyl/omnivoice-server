// Narrate (Chrome extension) protocol adapter in front of the OmniVoice anytts relay.
//
// Narrate expects (read from its content.js / options.js, v0.1.0):
//   GET  /config                      -> { voices: [id, ...] }
//   WS   /stream?voice=<id>           <- {"text": article}; -> binary PCM16 mono 24 kHz frames; close 1000 at end
//   POST /download {text,voice,title} -> audio/mpeg
// The relay speaks: GET /voices -> [{id,...}], POST / {engine:"openai",text,voice} -> whole mp3.
//
// Env: RELAY_URL (default http://127.0.0.1:8891), PORT (default 8892), HOST (default 127.0.0.1).
import http from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const RELAY = (process.env.RELAY_URL || "http://127.0.0.1:8891").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8892);
const HOST = process.env.HOST || "127.0.0.1";
const SAMPLE_RATE = 24000;
const FRAME_BYTES = SAMPLE_RATE * 2 / 2; // 0.5 s of PCM16 per WebSocket frame
const PIECE_CHARS = 400; // small pieces: first audio after one short synthesis

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Sentence-aligned pieces of at most `max` chars (a longer sentence is cut at spaces). */
export function splitText(text, max = PIECE_CHARS) {
  text = String(text).replace(/\s+/g, " ").trim();
  if (!text) return [];
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”»)\]]*\s*|[^.!?…]+$/g) || [text];
  const out = [];
  let cur = "";
  for (let s of sentences) {
    while (s.length > max) {
      let cut = s.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      if (cur.trim()) { out.push(cur.trim()); cur = ""; }
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    if ((cur + s).length > max && cur.trim()) { out.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function listVoiceIds() {
  const res = await fetch(`${RELAY}/voices`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`relay /voices ${res.status}`);
  return (await res.json()).map((v) => v.id);
}

async function synthMp3(text, voice, signal) {
  const res = await fetch(`${RELAY}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "openai", text, voice }),
    signal,
  });
  if (!res.ok) throw new Error(`relay ${res.status}: ${await res.text().catch(() => "")}`);
  return Buffer.from(await res.arrayBuffer());
}

/** mp3 bytes -> raw PCM16LE mono 24 kHz via ffmpeg. */
function mp3ToPcm(mp3) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"]);
    const chunks = [];
    let err = "";
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (c) => (err += c));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}: ${err}`))));
    ff.stdin.end(mp3);
  });
}

/** Length of a leading ID3v2 tag, 0 when absent. */
function id3Length(b) {
  if (b.length < 10 || b.toString("latin1", 0, 3) !== "ID3") return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return Math.min(b.length, 10 + size + (b[5] & 0x10 ? 10 : 0));
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  // Chrome Local Network Access preflight from a public page.
  "access-control-allow-private-network": "true",
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    if (req.method === "GET" && url.pathname === "/config") return sendJson(res, 200, { voices: await listVoiceIds() });
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });
    // OpenAI-compatible surface for the Read Aloud extension (Firefox Android): it tests the
    // connection with GET <url>/models and speaks with POST <url>/audio/speech.
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(res, 200, { object: "list", data: [{ id: "omnivoice", object: "model", owned_by: "spock" }] });
    }
    if (req.method === "GET" && url.pathname === "/v1/audio/voices") return sendJson(res, 200, { voices: await listVoiceIds() });
    if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
      let raw = "";
      for await (const c of req) raw += c;
      const { input, voice } = JSON.parse(raw || "{}");
      const pieces = splitText(input, 1500);
      if (!pieces.length) return sendJson(res, 400, { error: { message: "empty input" } });
      log("speech", voice, `${String(input).length} chars`);
      const parts = [];
      for (let i = 0; i < pieces.length; i++) {
        const mp3 = await synthMp3(pieces[i], voice);
        parts.push(i === 0 ? mp3 : mp3.subarray(id3Length(mp3)));
      }
      res.writeHead(200, { ...CORS, "content-type": "audio/mpeg" });
      return res.end(Buffer.concat(parts));
    }
    if (req.method === "POST" && url.pathname === "/download") {
      let raw = "";
      for await (const c of req) raw += c;
      const { text, voice } = JSON.parse(raw || "{}");
      const pieces = splitText(text, 1500);
      log("download", voice, `${String(text || "").length} chars`, `${pieces.length} pieces`);
      const parts = [];
      for (let i = 0; i < pieces.length; i++) {
        const mp3 = await synthMp3(pieces[i], voice);
        parts.push(i === 0 ? mp3 : mp3.subarray(id3Length(mp3)));
      }
      res.writeHead(200, { ...CORS, "content-type": "audio/mpeg" });
      return res.end(Buffer.concat(parts));
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    log("error", req.method, url.pathname, e.message);
    // OpenAI clients (Read Aloud) read `error.message`; Narrate only shows the text.
    if (!res.headersSent) sendJson(res, 502, { error: { message: e.message } });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => stream(ws, url.searchParams.get("voice") || ""));
});

function stream(ws, voice) {
  const abort = new AbortController();
  ws.on("close", () => abort.abort());
  ws.once("message", async (data) => {
    let text = "";
    try { text = JSON.parse(String(data)).text || ""; } catch { return ws.close(1003, "expected {text}"); }
    const pieces = splitText(text);
    const t0 = Date.now();
    log("stream start", voice, `${text.length} chars`, `${pieces.length} pieces`);
    try {
      // Prefetch one piece ahead: the relay serialises generation, so deeper prefetch gains nothing.
      let next = pieces.length ? synthMp3(pieces[0], voice, abort.signal).then(mp3ToPcm) : null;
      for (let i = 0; i < pieces.length; i++) {
        const pcm = await next;
        next = i + 1 < pieces.length ? synthMp3(pieces[i + 1], voice, abort.signal).then(mp3ToPcm) : null;
        next?.catch(() => {}); // surfaced when awaited
        if (i === 0) log("first audio after", Date.now() - t0, "ms");
        for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(pcm.subarray(off, off + FRAME_BYTES));
        }
      }
      log("stream done", `${Date.now() - t0} ms`);
      ws.close(1000);
    } catch (e) {
      if (abort.signal.aborted) return log("stream aborted by client");
      log("stream error", e.message);
      // 1011 = server error; Narrate shows "couldn't reach server (1011)" when nothing was played.
      ws.close(1011, e.message.slice(0, 100));
    }
  });
}

server.listen(PORT, HOST, () => log(`narrate-adapter on http://${HOST}:${PORT} -> relay ${RELAY}`));
