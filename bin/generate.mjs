#!/usr/bin/env node
// Generates today's log entry using KeylessAI and appends it to README.md
// between the DAILY_LOG_START / DAILY_LOG_END markers.
//
// Exits non-zero on failure so the GH Action goes red.

import { readFileSync, writeFileSync } from "node:fs";
import { streamChat } from "keylessai";

const README_PATH = "README.md";
const START = "<!-- DAILY_LOG_START -->";
const END = "<!-- DAILY_LOG_END -->";

// Pick one of a handful of daily-entry "modes". Rotates so the log
// doesn't get monotonous.
const MODES = [
  {
    name: "haiku",
    prompt: "Write a single haiku (5-7-5 syllables, three lines, no title, no commentary). Topic: a programming concept or a small everyday programmer moment. Output ONLY the haiku — no preface, no markdown, no quotes.",
  },
  {
    name: "tip",
    prompt: "Share ONE practical programming tip in 1-2 sentences. Be concrete. Don't say 'use meaningful variable names' or other clichés — something a mid-level engineer might actually learn. Output only the tip — no preface, no markdown fencing.",
  },
  {
    name: "joke",
    prompt: "Tell one short, clean programmer joke (1-3 lines). Output only the joke.",
  },
  {
    name: "quote",
    prompt: "Invent a plausible-sounding one-line aphorism about building software, attributed to a fictional engineer with a full name. Format: \"The aphorism.\" — Full Name. Output only that line.",
  },
  {
    name: "one-liner",
    prompt: "Write one useful bash or Python one-liner and briefly say what it does. Format: `code here` — brief explanation. Output only that line.",
  },
];

function pickMode() {
  const hash = Date.now() + Math.floor(Math.random() * 1000);
  return MODES[hash % MODES.length];
}

async function generate() {
  const mode = pickMode();
  console.log(`[keylessai-daily] mode: ${mode.name}`);

  let out = "";
  let provider = "?";
  for await (const chunk of streamChat({
    provider: "auto",
    messages: [
      { role: "system", content: "You are concise. Follow formatting instructions exactly." },
      { role: "user", content: mode.prompt },
    ],
    onProviderChange: (p) => { provider = p; },
    onStatus: (s) => console.log(`[keylessai-daily] ${s}`),
  })) {
    if (chunk.type === "content") out += chunk.text;
  }

  const text = out.trim();
  if (!text) {
    throw new Error("empty response");
  }
  return { mode: mode.name, text, provider };
}

function formatEntry({ mode, text, provider }) {
  const date = new Date().toISOString().slice(0, 10);
  return [
    `### ${date} · ${mode}`,
    "",
    text,
    "",
    `_via \`${provider}\`_`,
    "",
  ].join("\n");
}

function appendToReadme(entry) {
  const raw = readFileSync(README_PATH, "utf8");
  const start = raw.indexOf(START);
  const end = raw.indexOf(END);
  if (start < 0 || end < 0) {
    throw new Error("could not find daily log markers in README.md");
  }
  // Everything inside the markers is the accumulating log.
  const before = raw.slice(0, start + START.length);
  const after = raw.slice(end);
  const existing = raw.slice(start + START.length, end).trim();
  // Drop the placeholder once we have real content.
  const cleaned = existing.includes("_No entries yet.") ? "" : existing;
  const newLog = [entry, cleaned].filter(Boolean).join("\n");
  const next = `${before}\n${newLog}\n${after}`;
  writeFileSync(README_PATH, next, "utf8");
}

(async () => {
  try {
    const entry = await generate();
    appendToReadme(formatEntry(entry));
    console.log(`[keylessai-daily] appended entry (${entry.mode}, ${entry.text.length} chars, via ${entry.provider})`);
  } catch (e) {
    console.error(`[keylessai-daily] failed: ${e.message}`);
    process.exit(1);
  }
})();
