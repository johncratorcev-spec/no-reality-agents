#!/usr/bin/env node
/**
 * no-reality agent — a thin multimodal LLM wrapper.
 *
 * Just drop your API key and run:
 *   1) GET  {NO_REALITY_BASE_URL}/api/arena/round   (x-agent-key: ARENA_API_KEY)
 *   2) grab the clip's video, cut keyframes (ffmpeg, if available)
 *   3) ask your multimodal LLM: REAL or SYNTH?
 *   4) POST {NO_REALITY_BASE_URL}/api/arena/predict
 *
 * Supports: OpenAI-compatible endpoints (OpenAI, OpenRouter, Groq,
 * local gateways…), Anthropic and Google — see .env.example.
 *
 * Train your agent. Beat the humans. no-reality.fun
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/* ----------------------------- config ----------------------------- */

const BASE_URL = (process.env.NO_REALITY_BASE_URL || "https://no-reality.fun").replace(/\/$/, "");
const ARENA_KEY = (process.env.ARENA_API_KEY || "").trim();
const AGENT_NAME = (process.env.AGENT_NAME || "llm-wrapper").trim();
const POLL_SEC = Number(process.env.POLL_INTERVAL_SEC || 45);

const PROVIDER = (process.env.LLM_PROVIDER || "auto").toLowerCase(); // openai | anthropic | google | auto
const LLM_API_KEY = (process.env.LLM_API_KEY || "").trim();
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "").replace(/\/$/, "");
const LLM_MODEL = (process.env.LLM_MODEL || "").trim();
const FRAMES = Math.max(1, Number(process.env.FRAMES || 4));

const PROMPT =
  process.env.AGENT_PROMPT ||
  "Watch this video (keyframes attached). Is it real footage or synthetic (AI-generated)? " +
  "Answer with exactly one word first: REAL or SYNTH. Then give a one-sentence justification.";

const PROMPT_TEXT_ONLY =
  process.env.AGENT_PROMPT_TEXT_ONLY ||
  "You cannot watch the video directly. Judge by the clip's URL, author and any metadata. " +
  "Is it more likely REAL footage or SYNTHETIC (AI-generated)? " +
  "Answer with exactly one word first: REAL or SYNTH. Then one sentence why.";

function die(msg) {
  console.error(`[fatal] ${msg}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!ARENA_KEY) die("ARENA_API_KEY is not set — see .env.example");
if (!LLM_API_KEY) die("LLM_API_KEY is not set — see .env.example");

/* --------------------- no-reality arena client -------------------- */

async function api(path, method = "GET", body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "x-agent-key": ARENA_KEY,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ------------------------- video → frames ------------------------- */

async function hasFfmpeg() {
  try {
    await execFileP("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** Cut FRAMES evenly-spaced JPEG frames out of the clip. Returns [base64]. */
async function keyframes(videoUrl) {
  const dir = mkdtempSync(join(tmpdir(), "nr-agent-"));
  try {
    const file = join(dir, "clip.mp4");
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`video download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error("video download too small");
    writeFileSync(file, buf);

    const shots = [];
    for (let i = 0; i < FRAMES; i++) {
      const at = (i + 0.5) / FRAMES; // середина каждой из FRAMES долей
      const out = join(dir, `f${i}.jpg`);
      await execFileP("ffmpeg", [
        "-ss", String(at), "-i", file, "-frames:v", "1",
        "-vf", "scale=768:-2", "-q:v", "5", "-y", out,
      ]);
      if (existsSync(out)) shots.push(readFileSync(out).toString("base64"));
    }
    if (shots.length === 0) throw new Error("ffmpeg produced no frames");
    return shots;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------------------- LLM calls --------------------------- */

function detectProvider() {
  if (PROVIDER !== "auto") return PROVIDER;
  if (LLM_BASE_URL.includes("anthropic")) return "anthropic";
  if (LLM_BASE_URL.includes("generativelanguage")) return "google";
  return "openai"; // дефолт: любой OpenAI-compatible шлюз
}

function imageParts(b64, provider) {
  if (provider === "anthropic")
    return b64.map((d) => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: d },
    }));
  if (provider === "google")
    return b64.map((d) => ({
      inline_data: { mime_type: "image/jpeg", data: d },
    }));
  return b64.map((d) => ({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${d}` },
  }));
}

async function askLLM(prompt, b64frames) {
  const provider = detectProvider();
  const parts = imageParts(b64frames, provider);
  log(`llm: provider=${provider} model=${LLM_MODEL || "(default)"} frames=${b64frames.length}`);

  if (provider === "anthropic") {
    const model = LLM_MODEL || "claude-3-5-sonnet-latest";
    const res = await fetch(LLM_BASE_URL || "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": LLM_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...parts] }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    return (d.content ?? []).map((c) => c.text ?? "").join(" ");
  }

  if (provider === "google") {
    const model = LLM_MODEL || "gemini-2.0-flash";
    const url =
      (LLM_BASE_URL || `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`) +
      `?key=${encodeURIComponent(LLM_API_KEY)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, ...parts] }] }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`google HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    return (d.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(" ");
  }

  /* openai-compatible: OpenAI / OpenRouter / Groq / ваш шлюз */
  const model = LLM_MODEL || "gpt-4o-mini";
  const url = `${LLM_BASE_URL || "https://api.openai.com/v1"}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${LLM_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...parts] }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`openai HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content ?? "";
}

function parseCall(reply) {
  const m = String(reply).toUpperCase().match(/\b(REAL|SYNTH)\b/);
  if (!m) throw new Error(`no REAL/SYNTH in reply: ${String(reply).slice(0, 120)}`);
  return m[1].toLowerCase(); // real | synth
}

/* ------------------------------ loop ------------------------------ */

const done = new Set(); // clipCode, уже отправленные

async function tick() {
  const { round } = await api("/api/arena/round");
  if (!round?.clipCode) return;
  if (done.has(round.clipCode)) return;

  log(`round: ${round.clipCode} by ${round.author ?? "?"} (closes ${round.closesAt})`);
  done.add(round.clipCode);
  if (done.size > 500) done.clear(); // не растём вечно

  let b64 = [];
  let prompt = PROMPT;
  try {
    if (await hasFfmpeg()) {
      b64 = await keyframes(round.videoUrl);
    } else {
      log("ffmpeg not found — text-only fallback");
      prompt = PROMPT_TEXT_ONLY;
    }
  } catch (e) {
    log("frames failed:", e.message, "— text-only fallback");
    prompt = PROMPT_TEXT_ONLY;
  }

  const reply = await askLLM(prompt, b64);
  const call = parseCall(reply);
  const reasoning = String(reply).replace(/\s+/g, " ").slice(0, 300);

  const out = await api("/api/arena/predict", "POST", {
    clipCode: round.clipCode,
    call,
    reasoning,
    agentName: AGENT_NAME,
  });
  log(`predicted: ${round.clipCode} → ${call.toUpperCase()} (recorded ${out.recorded})`);
}

async function main() {
  log(`no-reality agent "${AGENT_NAME}" → ${BASE_URL}`);
  log(`poll every ${POLL_SEC}s · provider=${detectProvider()}`);
  if (!(await hasFfmpeg())) {
    log("hint: install ffmpeg for keyframes (apt install ffmpeg / brew install ffmpeg)");
  }
  while (true) {
    try {
      await tick();
    } catch (e) {
      log("error:", e.message, e.status ? `(HTTP ${e.status})` : "");
    }
    await sleep(POLL_SEC * 1000);
  }
}

main();
