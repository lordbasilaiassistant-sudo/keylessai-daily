#!/usr/bin/env node
// Generates today's log entry using KeylessAI and appends it to README.md
// between the DAILY_LOG_START / DAILY_LOG_END markers.
//
// Diversity strategy: pollinations is roughly deterministic (no temperature
// knob), so left alone it returns the same haiku/quote/joke every run. We
// fight that with three levers:
//   1. Read all prior entries out of the README and pass them to the model
//      as an explicit forbidden list ("do not repeat any of these").
//   2. Bias today's mode toward whichever mode has appeared least recently.
//   3. Inject a random "spice" seed (topic / constraint / persona) into the
//      prompt so even the same mode gets a different starting point.
// After generation we normalize and dedupe against past entries; if it
// collides we retry with a different mode and a stronger forbidden list.
//
// Exits non-zero on failure so the GH Action goes red.

import { readFileSync, writeFileSync } from "node:fs";
import { streamChat } from "keylessai";

const README_PATH = "README.md";
const START = "<!-- DAILY_LOG_START -->";
const END = "<!-- DAILY_LOG_END -->";
const MAX_ATTEMPTS = 4;
const RECENT_WINDOW = 60; // how many past entries to consider for dedupe + mode rotation

const MODES = {
  haiku: {
    base: "Write a single haiku (5-7-5 syllables, three lines, no title, no commentary). Output ONLY the haiku — no preface, no markdown, no quotes.",
    spices: [
      "Topic: a git operation gone wrong.",
      "Topic: the moment a test finally passes.",
      "Topic: a forgotten TODO comment.",
      "Topic: 3am debugging.",
      "Topic: legacy code archaeology.",
      "Topic: a kernel panic.",
      "Topic: cache invalidation.",
      "Topic: the silence after `npm install`.",
      "Topic: a broken CI pipeline.",
      "Topic: a regex that finally works.",
      "Topic: the empty inbox of a maintainer.",
      "Topic: a stale Docker layer.",
      "Topic: an off-by-one error.",
      "Topic: cleaning up a feature branch.",
      "Topic: the loneliness of an unused import.",
    ],
  },
  tip: {
    base: "Share ONE practical programming tip in 1-2 sentences. Be concrete and specific. AVOID clichés like 'use meaningful names', 'write tests', 'comment your code', 'DRY', 'KISS'. Output only the tip — no preface, no markdown fencing, no list bullet.",
    spices: [
      "Domain: shell / Unix / coreutils.",
      "Domain: git internals or plumbing commands.",
      "Domain: Postgres query performance.",
      "Domain: HTTP / curl debugging.",
      "Domain: Python stdlib quirks.",
      "Domain: JavaScript / Node.js gotchas.",
      "Domain: Docker layer caching.",
      "Domain: regex.",
      "Domain: ssh and tmux.",
      "Domain: vim or nvim.",
      "Domain: filesystem and inodes.",
      "Domain: TLS / certificates.",
      "Domain: DNS debugging.",
      "Domain: systemd units.",
      "Domain: editor config.",
      "Domain: process / signal handling.",
      "Domain: memory profiling.",
      "Domain: build tools (make, cargo, gradle).",
    ],
  },
  joke: {
    base: "Tell one short, clean programmer joke (1-3 lines). It must be original or obscure — NOT 'why programmers prefer dark mode', NOT 'there are 10 types of people', NOT 'how many programmers does it take'. Output only the joke.",
    spices: [
      "Style: groan-worthy pun.",
      "Style: deadpan one-liner.",
      "Style: misdirection.",
      "Style: bash prompt dialogue.",
      "Style: corporate satire.",
      "Style: fake stack trace.",
      "Style: customer support roleplay.",
      "Style: rubber duck dialogue.",
      "Topic: a language war (any flavor).",
      "Topic: pair programming.",
      "Topic: a code review.",
      "Topic: production incident.",
    ],
  },
  quote: {
    base: 'Invent a plausible-sounding one-line aphorism about building software, attributed to a fictional engineer with a full name. The name must be plausible but not match any well-known person. Format exactly: "The aphorism." — Full Name. Output only that line.',
    spices: [
      "Theme: technical debt.",
      "Theme: premature optimization.",
      "Theme: deleting code.",
      "Theme: meetings vs writing code.",
      "Theme: the cost of abstractions.",
      "Theme: shipping vs polishing.",
      "Theme: documentation rot.",
      "Theme: distributed systems failure.",
      "Theme: code review etiquette.",
      "Theme: legacy systems.",
      "Theme: working with juniors.",
      "Theme: working with seniors.",
      "Theme: monitoring and observability.",
      "Theme: on-call life.",
    ],
  },
  "one-liner": {
    base: "Write one useful bash, awk, jq, or Python one-liner and briefly say what it does. The one-liner should be non-obvious — NOT 'list .py files', NOT 'count lines', NOT 'find largest file'. Format: `code here` — brief explanation. Output only that line, no markdown fencing around the whole thing.",
    spices: [
      "Tool: awk.",
      "Tool: jq.",
      "Tool: sed.",
      "Tool: xargs.",
      "Tool: find with -exec.",
      "Tool: pure bash parameter expansion.",
      "Tool: python -c using collections.",
      "Tool: python -c using itertools.",
      "Tool: ripgrep with capture groups.",
      "Tool: comm or diff.",
      "Tool: sort + uniq tricks.",
      "Tool: ss or netstat.",
      "Tool: lsof.",
      "Tool: git plumbing.",
    ],
  },
  "log-line": {
    base: "Invent one realistic log line a backend engineer might see at 3am during an outage, plus a one-sentence guess at what's actually happening. Format: `LOG LINE` — your guess. Output only that line.",
    spices: [
      "System: Postgres.",
      "System: Kafka.",
      "System: Redis.",
      "System: Kubernetes.",
      "System: Nginx.",
      "System: a Go service.",
      "System: a Node.js service.",
      "System: a Python worker.",
      "System: an Elasticsearch cluster.",
      "System: a load balancer.",
    ],
  },
  fact: {
    base: "Share ONE genuinely surprising fact about how a piece of software, protocol, or computing history actually works. One or two sentences. Avoid the over-told ones (Linus and Linux, Ada Lovelace, the first bug being a moth). Output only the fact.",
    spices: [
      "Domain: Unix history.",
      "Domain: TCP/IP quirks.",
      "Domain: filesystem internals.",
      "Domain: a programming language's origin.",
      "Domain: a compiler optimization.",
      "Domain: a famous outage.",
      "Domain: cryptography history.",
      "Domain: a deprecated standard that still ships.",
      "Domain: a CPU architectural quirk.",
      "Domain: an HTTP header nobody uses.",
    ],
  },
  changelog: {
    base: "Write one fictional but plausible changelog entry for an imaginary open-source library. Format: `vX.Y.Z` — one-line description of the change. Make it specific and dryly funny if you can. Output only that line.",
    spices: [
      "Project type: a logging library.",
      "Project type: a date/time library.",
      "Project type: an HTTP client.",
      "Project type: a CLI argument parser.",
      "Project type: an ORM.",
      "Project type: a build tool.",
      "Project type: a test runner.",
      "Project type: a linter.",
      "Project type: a config-file parser.",
      "Project type: a notification daemon.",
    ],
  },
};

const MODE_NAMES = Object.keys(MODES);

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- README parsing -------------------------------------------------------

function readReadme() {
  return readFileSync(README_PATH, "utf8");
}

function extractLog(raw) {
  const start = raw.indexOf(START);
  const end = raw.indexOf(END);
  if (start < 0 || end < 0) {
    throw new Error("could not find daily log markers in README.md");
  }
  return {
    before: raw.slice(0, start + START.length),
    after: raw.slice(end),
    body: raw.slice(start + START.length, end).trim(),
  };
}

// Parse entries shaped like:
//   ### YYYY-MM-DD · mode
//
//   ...text (1+ lines)...
//
//   _via `provider`_
function parseEntries(body) {
  if (!body || body.includes("_No entries yet.")) return [];
  const entries = [];
  const re = /^###\s+(\d{4}-\d{2}-\d{2})\s+·\s+([\w-]+)\s*$/gm;
  const headers = [];
  for (const m of body.matchAll(re)) {
    headers.push({ date: m[1], mode: m[2], idx: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const nextStart = i + 1 < headers.length ? headers[i + 1].idx : body.length;
    const block = body.slice(h.end, nextStart).trim();
    // Strip trailing _via `xxx`_ line
    const text = block.replace(/\n+_via\s+`[^`]*`_\s*$/i, "").trim();
    entries.push({ date: h.date, mode: h.mode, text });
  }
  return entries;
}

// --- Diversity helpers ----------------------------------------------------

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[`*_>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicate(candidate, recentEntries) {
  const norm = normalize(candidate);
  for (const e of recentEntries) {
    const en = normalize(e.text);
    if (!en) continue;
    if (en === norm) return true;
    // Substring match in either direction catches near-duplicates and
    // the common "model paraphrases its prior output" case.
    if (en.length > 30 && (norm.includes(en) || en.includes(norm))) return true;
  }
  return false;
}

// Pick a mode that has appeared least often in the recent window.
// Excludes any modes the caller has already tried this run.
function pickMode(recentEntries, exclude = new Set()) {
  const counts = Object.fromEntries(MODE_NAMES.map((m) => [m, 0]));
  for (const e of recentEntries) {
    if (counts[e.mode] !== undefined) counts[e.mode]++;
  }
  const candidates = MODE_NAMES.filter((m) => !exclude.has(m));
  if (!candidates.length) return pickRandom(MODE_NAMES);
  // Lowest-count modes win; ties broken randomly.
  const minCount = Math.min(...candidates.map((m) => counts[m]));
  const tier = candidates.filter((m) => counts[m] === minCount);
  return pickRandom(tier);
}

// --- Generation -----------------------------------------------------------

function buildSystem(forbiddenSamples) {
  const lines = [
    "You are a content generator for a public daily log. Follow the user's formatting instructions exactly — no preface, no apologies, no markdown beyond what is requested.",
    "Your single most important constraint: DO NOT repeat or paraphrase anything from the FORBIDDEN list below. Pick something genuinely different in topic, structure, and wording.",
  ];
  if (forbiddenSamples.length) {
    lines.push("");
    lines.push("FORBIDDEN — these have already been published, do not output any of them again, paraphrased or otherwise:");
    for (const s of forbiddenSamples) {
      lines.push(`- ${s.replace(/\n+/g, " ⏎ ")}`);
    }
  }
  return lines.join("\n");
}

async function generateOnce({ mode, modeName, forbiddenSamples }) {
  const spice = pickRandom(mode.spices);
  const seed = Math.random().toString(36).slice(2, 8);
  const userPrompt = [
    mode.base,
    "",
    spice,
    `Variation seed (do not echo): ${seed}.`,
  ].join("\n");

  let out = "";
  let provider = "?";
  for await (const chunk of streamChat({
    provider: "auto",
    messages: [
      { role: "system", content: buildSystem(forbiddenSamples) },
      { role: "user", content: userPrompt },
    ],
    onProviderChange: (p) => { provider = p; },
    onStatus: (s) => console.log(`[keylessai-daily] ${s}`),
  })) {
    if (chunk.type === "content") out += chunk.text;
  }

  const text = out.trim();
  return { modeName, text, provider, spice };
}

async function generate(recentEntries) {
  const forbiddenSamples = recentEntries.slice(0, RECENT_WINDOW).map((e) => e.text);
  const tried = new Set();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const modeName = pickMode(recentEntries, tried);
    tried.add(modeName);
    const mode = MODES[modeName];
    console.log(`[keylessai-daily] attempt ${attempt}: mode=${modeName}`);

    const result = await generateOnce({ mode, modeName, forbiddenSamples });
    if (!result.text) {
      console.log(`[keylessai-daily] attempt ${attempt}: empty response, retrying`);
      continue;
    }
    if (isDuplicate(result.text, recentEntries)) {
      console.log(`[keylessai-daily] attempt ${attempt}: duplicate of past entry, retrying with different mode`);
      // Add the dupe to the forbidden list too, in case the next mode collides.
      forbiddenSamples.unshift(result.text);
      continue;
    }
    return result;
  }
  throw new Error(`could not generate a non-duplicate entry after ${MAX_ATTEMPTS} attempts`);
}

// --- README write ---------------------------------------------------------

function formatEntry({ modeName, text, provider }) {
  const date = new Date().toISOString().slice(0, 10);
  return [
    `### ${date} · ${modeName}`,
    "",
    text,
    "",
    `_via \`${provider}\`_`,
    "",
  ].join("\n");
}

function writeReadme(entry, parsed) {
  const existing = parsed.body.includes("_No entries yet.") ? "" : parsed.body;
  const newLog = [entry, existing].filter(Boolean).join("\n");
  const next = `${parsed.before}\n${newLog}\n${parsed.after}`;
  writeFileSync(README_PATH, next, "utf8");
}

// --- main -----------------------------------------------------------------

(async () => {
  try {
    const raw = readReadme();
    const parsed = extractLog(raw);
    const recentEntries = parseEntries(parsed.body);
    console.log(`[keylessai-daily] ${recentEntries.length} prior entries on file`);

    const result = await generate(recentEntries);
    writeReadme(formatEntry(result), parsed);

    console.log(
      `[keylessai-daily] appended (${result.modeName}, ${result.text.length} chars, via ${result.provider})`
    );
  } catch (e) {
    console.error(`[keylessai-daily] failed: ${e.message}`);
    process.exit(1);
  }
})();
