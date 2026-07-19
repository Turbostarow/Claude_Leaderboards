#!/usr/bin/env node
"use strict";

/*
 * Discord game leaderboards, driven entirely by GitHub Actions.
 *
 * Each run:
 *   1. reads new messages in the private mod channel and applies !commands
 *      (reacting with a checkmark or an X + error reply on each one),
 *   2. commits nothing itself - it just rewrites data/*.json; the workflow
 *      commits the diff,
 *   3. re-renders each game's leaderboard embed and edits the bot's single
 *      message in that game's public channel (posting it if missing).
 *
 * Zero dependencies - Node 18+ global fetch only.
 *
 * Env:  DISCORD_TOKEN  (required)
 *       FORCE_RENDER   ("true" re-renders every leaderboard even if no data changed)
 * Args: --check        (validate token + channel access, change nothing, send nothing)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

const API = "https://discord.com/api/v10";
const TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const CHECK_ONLY = process.argv.includes("--check");
const FORCE_RENDER = (process.env.FORCE_RENDER || "").toLowerCase() === "true";

const CHECK = "✅"; // white heavy check mark
const CROSS = "❌"; // cross mark

if (!TOKEN) {
  console.error("DISCORD_TOKEN environment variable is not set.");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Discord REST                                                        */
/* ------------------------------------------------------------------ */

async function api(method, route, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API + route, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://github.com/Turbostarow/Claude_Leaderboards, 1.0)",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const info = await res.json().catch(() => ({}));
      const waitMs = Math.ceil(((info.retry_after ?? 1) + 0.5) * 1000);
      console.warn(`Rate limited on ${method} ${route}; waiting ${waitMs} ms`);
      await sleep(waitMs);
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${method} ${route} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`Gave up after repeated rate limits on ${method} ${route}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snowflakeNow() {
  return ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
}

/* ------------------------------------------------------------------ */
/* Rank parsing                                                        */
/* ------------------------------------------------------------------ */

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
const TO_ROMAN = ["I", "II", "III", "IV", "V", "VI"];

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tierLookup(game) {
  const g = CONFIG.games[game];
  const map = new Map();
  g.tiers.forEach((t, i) => map.set(normalize(t), i));
  for (const [alias, tier] of Object.entries(g.tierAliases || {})) {
    const idx = g.tiers.findIndex((t) => normalize(t) === normalize(tier));
    if (idx !== -1) map.set(normalize(alias), idx);
  }
  return map;
}

/**
 * Parse a user-supplied rank ("Diamond 2", "gm III", "Eternity", "unranked")
 * into { score, display }. Higher score = better. Throws on garbage.
 */
function parseRank(game, input) {
  const g = CONFIG.games[game];
  const cleaned = normalize(String(input));
  if (!cleaned || ["unranked", "none", "n a", "tbd"].includes(cleaned)) {
    return { score: -1, display: "Unranked" };
  }

  let words = cleaned.split(" ");
  let division = null;

  // Peel a trailing division off the last word ("gold2", "gold ii", "gold 2").
  const last = words[words.length - 1];
  if (/^\d+$/.test(last)) {
    division = parseInt(last, 10);
    words = words.slice(0, -1);
  } else if (ROMAN[last] !== undefined && words.length > 1) {
    division = ROMAN[last];
    words = words.slice(0, -1);
  } else {
    const glued = last.match(/^([a-z]+?)(\d+|vi|iv|iii|ii|i|v)$/);
    if (glued && words.length >= 1) {
      words = [...words.slice(0, -1), glued[1]];
      division = /^\d+$/.test(glued[2]) ? parseInt(glued[2], 10) : ROMAN[glued[2]];
    }
  }

  const lookup = tierLookup(game);
  const tierIdx = lookup.get(words.join(" "));
  if (tierIdx === undefined) {
    throw new Error(
      `Unknown ${g.label} rank "${input}". Valid tiers: ${g.tiers.join(", ")}.`
    );
  }

  const tierName = g.tiers[tierIdx];
  const divisionless = (g.divisionlessTiers || []).some(
    (t) => normalize(t) === normalize(tierName)
  );

  if (divisionless || division === null) {
    // No division (or a points value we ignore): score as the bottom of the tier.
    return { score: tierIdx * 10, display: tierName };
  }

  if (division < 1 || division > g.divisionCount) {
    throw new Error(
      `${g.label}: ${tierName} has divisions 1-${g.divisionCount}, got "${division}".`
    );
  }

  const within = g.divisionAscending ? division - 1 : g.divisionCount - division;
  const divDisplay = g.divisionStyle === "roman" ? TO_ROMAN[division - 1] : String(division);
  return { score: tierIdx * 10 + within, display: `${tierName} ${divDisplay}` };
}

function scoreOf(game, display) {
  try {
    return parseRank(game, display).score;
  } catch {
    return -1;
  }
}

/* ------------------------------------------------------------------ */
/* Data files                                                          */
/* ------------------------------------------------------------------ */

function dataPath(game) {
  return path.join(DATA_DIR, `${game}.json`);
}

function loadData() {
  const data = {};
  for (const game of Object.keys(CONFIG.games)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dataPath(game), "utf8"));
      data[game] = Array.isArray(parsed) ? parsed.filter((p) => p && p.id) : [];
    } catch {
      data[game] = [];
    }
  }
  return data;
}

function saveData(game, players) {
  fs.writeFileSync(dataPath(game), JSON.stringify(players, null, 2) + "\n");
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { modChannelLastMessageId: null, leaderboardMessages: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

/* ------------------------------------------------------------------ */
/* Command parsing                                                     */
/* ------------------------------------------------------------------ */

const HELP_TEXT = [
  "**Leaderboard commands** (picked up every ~20 min, or instantly via the workflow's Run button)",
  "```",
  "!add <game> @player rank: <rank> [peak: <rank>] [role: <text>] [name: <text>]",
  "!update <game> @player [rank: ...] [peak: ...] [role: ...] [name: ...]",
  "!remove <game> @player",
  "!refresh        force re-render of all leaderboards",
  "!help           show this message",
  "```",
  "Games: `rivals` / `ow` / `deadlock` (more aliases accepted). `hero:` works as an alias for `role:`.",
  "Several commands in one message (one per line) are fine.",
  "Examples:",
  "```",
  "!add rivals @Luna rank: Diamond 2 peak: GM 3 role: Duelist",
  "!update ow @Luna rank: Master 4",
  "!add deadlock @Luna rank: Oracle 4 hero: Haze",
  "!remove rivals @Luna",
  "```",
].join("\n");

function resolveGame(token) {
  const t = normalize(token || "");
  for (const [key, g] of Object.entries(CONFIG.games)) {
    if (normalize(key) === t) return key;
    if ((g.aliases || []).some((a) => normalize(a) === t)) return key;
  }
  const all = Object.entries(CONFIG.games)
    .map(([k, g]) => `${k} (${(g.aliases || []).join("/")})`)
    .join(", ");
  throw new Error(`Unknown game "${token}". Use one of: ${all}`);
}

function parseFields(text) {
  const out = {};
  const re = /\b(rank|peak|role|hero|name)\s*:/gi;
  const matches = [...text.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1].toLowerCase();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const value = text.slice(start, end).trim();
    if (value) out[key === "hero" ? "role" : key] = value;
  }
  return out;
}

function escMd(s) {
  return String(s).replace(/([\\*_~`|>])/g, "\\$1");
}

/* ------------------------------------------------------------------ */
/* Command execution                                                   */
/* ------------------------------------------------------------------ */

async function executeLine(line, ctx) {
  const stripped = line.replace(/^!/, "").trim();
  const cmd = (stripped.split(/\s+/)[0] || "").toLowerCase();
  const rest = stripped.slice(cmd.length).trim();

  if (cmd === "help") return { reply: HELP_TEXT, ping: true };
  if (cmd === "refresh") {
    ctx.forceRender = true;
    return { reply: "Re-rendering all leaderboards." };
  }

  if (!["add", "update", "remove"].includes(cmd)) {
    throw new Error(`Unknown command \`!${cmd}\`. Try \`!help\`.`);
  }

  const gameToken = rest.split(/\s+/)[0] || "";
  const game = resolveGame(gameToken);
  const g = CONFIG.games[game];

  const mention = rest.match(/<@!?(\d+)>/);
  if (!mention) {
    throw new Error(`\`!${cmd}\` needs an @mention of the player. Try \`!help\`.`);
  }
  const userId = mention[1];

  const afterGame = rest.slice(rest.indexOf(gameToken) + gameToken.length);
  const fields = parseFields(afterGame.replace(/<@!?\d+>/, " "));

  const players = ctx.data[game];
  const existing = players.find((p) => p.id === userId);

  if (cmd === "remove") {
    if (!existing) throw new Error(`That player is not on the ${g.label} leaderboard.`);
    ctx.data[game] = players.filter((p) => p.id !== userId);
    ctx.changed.add(game);
    return { reply: `Removed **${escMd(existing.name)}** from the ${g.label} leaderboard.` };
  }

  if (cmd === "update" && !existing) {
    throw new Error(`That player is not on the ${g.label} leaderboard yet - use \`!add\`.`);
  }
  if (cmd === "add" && !existing && !fields.rank) {
    throw new Error(`\`!add\` needs at least \`rank: <rank>\`. Try \`!help\`.`);
  }
  if (cmd === "update" && Object.keys(fields).length === 0) {
    throw new Error(`\`!update\` needs at least one field (rank/peak/role/name).`);
  }

  const entry = existing || { id: userId };
  const notes = [];

  if (fields.rank) entry.rank = parseRank(game, fields.rank).display;
  if (fields.peak) entry.peak = parseRank(game, fields.peak).display;
  if (!entry.peak && entry.rank) entry.peak = entry.rank;
  if (fields.role) entry.role = fields.role;
  if (!entry.role) entry.role = "-";
  if (fields.name) {
    entry.name = fields.name;
  } else if (!entry.name) {
    entry.name = await ctx.displayName(userId);
  }

  // Peak can never sit below current rank.
  if (scoreOf(game, entry.rank) > scoreOf(game, entry.peak)) {
    entry.peak = entry.rank;
    notes.push("peak raised to match current rank");
  }

  entry.updatedAt = new Date().toISOString();
  if (!existing) players.push(entry);
  ctx.changed.add(game);

  const verb = cmd === "add" && !existing ? "Added" : "Updated";
  const suffix = notes.length ? ` (${notes.join("; ")})` : "";
  return {
    reply: `${verb} **${escMd(entry.name)}** on the ${g.label} leaderboard: ${entry.rank}, peak ${entry.peak}, ${g.roleLabel.toLowerCase()}: ${escMd(entry.role)}${suffix}`,
  };
}

async function handleMessage(msg, ctx) {
  if (msg.author?.bot) return;
  const lines = (msg.content || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("!"));
  if (lines.length === 0) return;

  const errors = [];
  const replies = [];
  let ping = false;
  for (const line of lines) {
    try {
      const r = await executeLine(line, ctx);
      if (r.reply) replies.push(r.reply);
      if (r.ping) ping = true;
    } catch (e) {
      errors.push(lines.length > 1 ? `\`${line.slice(0, 80)}\` -> ${e.message}` : e.message);
    }
  }

  const ok = errors.length === 0;

  // Mirror the command (and its outcome) to the log channel, then delete the
  // original so the mod channel stays clean. Both steps degrade gracefully:
  // no log channel or missing permissions -> old reaction/reply behaviour.
  const logged = await ctx.log(msg, ok, replies, errors, ping || !ok);
  const deleted = logged ? await ctx.deleteMessage(msg.id) : false;

  if (!deleted) {
    await ctx.react(msg.id, ok ? CHECK : CROSS);
    if (!logged) {
      const parts = [];
      if (errors.length) parts.push(errors.map((e) => `${CROSS} ${e}`).join("\n"));
      if (replies.length) parts.push(replies.join("\n"));
      if (parts.length) await ctx.reply(msg.id, parts.join("\n"));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Mod-channel polling                                                 */
/* ------------------------------------------------------------------ */

async function pollModChannel(ctx, state) {
  const modId = CONFIG.modChannelId;

  if (!ctx.lastId) {
    // First ever run: set the baseline to the newest existing message so we
    // don't replay the channel's history as commands.
    const latest = await api("GET", `/channels/${modId}/messages?limit=1`);
    state.modChannelLastMessageId = latest?.[0]?.id ?? snowflakeNow();
    console.log("Mod channel baseline set; commands posted from now on will be processed.");
    return;
  }

  const collected = [];
  let after = ctx.lastId;
  for (let page = 0; page < 10; page++) {
    const batch = await api("GET", `/channels/${modId}/messages?after=${after}&limit=100`);
    if (!batch || batch.length === 0) break;
    collected.push(...batch);
    after = batch.reduce((m, x) => (BigInt(x.id) > BigInt(m) ? x.id : m), after);
    if (batch.length < 100) break;
  }

  collected.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  if (collected.length) console.log(`Processing ${collected.length} new mod-channel message(s).`);

  for (const msg of collected) {
    await handleMessage(msg, ctx);
    state.modChannelLastMessageId = msg.id;
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function compareEntries(game) {
  return (a, b) => {
    const d = scoreOf(game, b.rank) - scoreOf(game, a.rank);
    if (d !== 0) return d;
    const p = scoreOf(game, b.peak) - scoreOf(game, a.peak);
    if (p !== 0) return p;
    // Tie on both ranks: whoever reached it first (older update) sits higher.
    const ta = Date.parse(a.updatedAt) || 0;
    const tb = Date.parse(b.updatedAt) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.name).localeCompare(String(b.name));
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso) {
  const t = Date.parse(iso);
  if (!t) return "--";
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`;
}

/** Split a canonical rank display ("Diamond II") into tier index + division suffix. */
function splitRankDisplay(game, display) {
  const g = CONFIG.games[game];
  if (!display || display === "Unranked") return { idx: -1, suffix: "" };
  let idx = -1;
  let len = -1;
  g.tiers.forEach((t, i) => {
    if ((display === t || display.startsWith(t + " ")) && t.length > len) {
      idx = i;
      len = t.length;
    }
  });
  return idx === -1 ? { idx: -1, suffix: "" } : { idx, suffix: display.slice(len).trim() };
}

function shortRank(game, display) {
  const g = CONFIG.games[game];
  const { idx, suffix } = splitRankDisplay(game, display);
  if (idx === -1) return "Unrk";
  const short = (g.tierShort || [])[idx] || g.tiers[idx];
  return suffix ? `${short} ${suffix}` : short;
}

function rankEmoji(game, display, emojiMap) {
  const g = CONFIG.games[game];
  const { idx } = splitRankDisplay(game, display);
  const raw = (idx !== -1 && (g.tierEmoji || [])[idx]) || "\u{1F539}";
  const named = raw.match(/^:(.+):$/); // ":grandmaster:" -> custom server emoji
  if (!named) return raw;
  const e = emojiMap && emojiMap.get(named[1]);
  return e ? `<${e.animated ? "a" : ""}:${e.name}:${e.id}>` : "\u{1F539}";
}

/** Pad/truncate to a fixed width (ellipsis on overflow). */
function pad(s, w) {
  s = String(s);
  return s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s.padEnd(w);
}

function embedBase(g) {
  return {
    title: `\u{1F3C6} ${g.label} — Leaderboard`,
    color: parseInt(String(g.color).replace(/^#/, ""), 16) || 0x5865f2,
    footer: { text: "Peak/current ranks are from the current season · the board resets each new season" },
    timestamp: new Date().toISOString(),
  };
}

const ROLE_PAD = 12;
const FIG = " "; // figure space - Discord renders it, never collapses it

function roleEmojiFor(game, role, emojiMap) {
  const g = CONFIG.games[game];
  const raw = (g.roleEmoji || {})[normalize(String(role || ""))];
  if (!raw) return null;
  const named = String(raw).match(/^:(.+):$/);
  if (!named) return raw;
  const e = emojiMap && emojiMap.get(named[1]);
  return e ? `<${e.animated ? "a" : ""}:${e.name}:${e.id}>` : null;
}

/** Default style: a 3-column field grid - the closest Discord gets to a real table. */
function buildTableEmbed(game, g, sorted, ctx) {
  if (!sorted.length) return { ...embedBase(g), description: "*No players tracked yet.*" };

  const c1 = [];
  const c2 = [];
  const c3 = [];
  sorted.forEach((p, i) => {
    const ts = p.updatedAt ? `<t:${Math.floor(Date.parse(p.updatedAt) / 1000)}:R>` : "—";
    // Real member ids become mention chips; demo/placeholder ids show as bold names.
    const who = /^\d+$/.test(String(p.id)) ? `<@${p.id}>` : `**${escMd(p.name || p.id)}**`;
    c1.push(`**#${i + 1}**${FIG}${FIG} ${who}`);
    // Pad the current rank so the dot sits at a near-fixed column between rank and peak.
    const cur = shortRank(game, p.rank);
    c2.push(
      `${rankEmoji(game, p.rank, ctx && ctx.emojiMap)} **${cur}**${FIG.repeat(Math.max(2, 10 - cur.length))}·${FIG}${FIG}${shortRank(game, p.peak)}`
    );
    const role = String(p.role || "-").slice(0, ROLE_PAD);
    const rEmoji = roleEmojiFor(game, p.role, ctx && ctx.emojiMap);
    c3.push(
      (rEmoji ? `${rEmoji} ` : FIG.repeat(3)) +
        escMd(role) +
        FIG.repeat(Math.max(1, ROLE_PAD - role.length)) +
        ts
    );
  });

  let cut = false;
  while ([c1, c2, c3].some((c) => c.join("\n").length > 1000) && c1.length > 1) {
    c1.pop();
    c2.pop();
    c3.pop();
    cut = true;
  }

  const embed = {
    ...embedBase(g),
    fields: [
      { name: `#${FIG}${FIG} · Player`, value: c1.join("\n"), inline: true },
      { name: `Current Rank${FIG}·${FIG}${FIG}Peak`, value: c2.join("\n"), inline: true },
      { name: `${FIG.repeat(5)}${g.roleShort || "Role"}${FIG.repeat(7)}Updated`, value: c3.join("\n"), inline: true },
      { name: "​", value: "​", inline: false }, // breathing room above the footer
    ],
  };
  if (cut) embed.description = "*…list truncated*";
  return embed;
}

/** "rows" style: one markdown line per player. */
function buildRowsEmbed(game, g, sorted, ctx) {
  const lines = [`**Pos · Player · Rank · Peak · ${g.roleShort || "Role"} · Updated**`];
  sorted.forEach((p, i) => {
    const badge = ["\u{1F7E1}", "\u{1F535}", "\u{1F7E2}"][i] || "⚪"; // gold/blue/green, rest white
    const ts = p.updatedAt ? `<t:${Math.floor(Date.parse(p.updatedAt) / 1000)}:R>` : "—";
    lines.push(
      `${badge} **#${i + 1}** <@${p.id}> · ${rankEmoji(game, p.rank, ctx && ctx.emojiMap)} **${shortRank(game, p.rank)}** · ${shortRank(game, p.peak)} · ${escMd(p.role || "-")} · ${ts}`
    );
  });

  let description;
  if (!sorted.length) {
    description = "*No players tracked yet.*";
  } else {
    let cut = false;
    while (lines.join("\n").length > 3950 && lines.length > 2) {
      lines.pop();
      cut = true;
    }
    description = lines.join("\n") + (cut ? "\n*…list truncated*" : "") + "\n\n​";
  }

  return { ...embedBase(g), description };
}

function buildEmbed(game, players, ctx) {
  const g = CONFIG.games[game];
  const sorted = [...players].sort(compareEntries(game));
  const style = CONFIG.renderStyle || "table";
  if (style === "table") return buildTableEmbed(game, g, sorted, ctx);
  if (style !== "ansi") return buildRowsEmbed(game, g, sorted, ctx);
  const useAnsi = CONFIG.ansiColors !== false;
  const ESC = "\u001b";

  // Column widths tuned to fit an embed code block without wrapping (~56 chars).
  // Cells are joined with a space so maxed-out content never fuses columns.
  const W = { pos: 2, name: 13, rank: 6, peak: 6, role: 10 };

  const header = [
    pad("#", W.pos),
    pad("Player", W.name),
    pad("Rank", 3 + W.rank), // 3 = emoji (2 units) + space in data rows
    pad("Peak", W.peak),
    pad(g.roleShort || "Role", W.role),
    "Upd",
  ].join(" ");
  const lines = [useAnsi ? `${ESC}[1;4m${header}${ESC}[0m` : header];

  sorted.forEach((p, i) => {
    const row = [
      pad(i + 1, W.pos),
      pad(p.name, W.name),
      rankEmoji(game, p.rank) + " " + pad(shortRank(game, p.rank), W.rank),
      pad(shortRank(game, p.peak), W.peak),
      pad(p.role || "-", W.role),
      shortDate(p.updatedAt),
    ].join(" ");
    const color = i === 0 ? "1;33" : i === 1 ? "1;34" : i === 2 ? "1;32" : null; // gold / blue / green
    lines.push(useAnsi && color ? `${ESC}[${color}m${row}${ESC}[0m` : row);
  });

  let description;
  if (!sorted.length) {
    description = "*No players tracked yet.*";
  } else {
    let cut = false;
    while (lines.join("\n").length > 3900 && lines.length > 2) {
      lines.pop();
      cut = true;
    }
    description =
      "```" + (useAnsi ? "ansi" : "") + "\n" + lines.join("\n") + "\n```" +
      (cut ? "\n*…list truncated*" : "");
  }

  return {
    title: `\u{1F3C6} ${g.label} — Leaderboard`,
    color: parseInt(String(g.color).replace(/^#/, ""), 16) || 0x5865f2,
    description,
    footer: { text: "Sorted: rank → peak → earliest update · Auto-refresh ~20 min" },
    timestamp: new Date().toISOString(),
  };
}

async function renderLeaderboard(game, ctx, state) {
  const g = CONFIG.games[game];
  const embed = buildEmbed(game, ctx.data[game], ctx);
  const body = { content: "", embeds: [embed], allowed_mentions: { parse: [] } };
  const existingId = state.leaderboardMessages?.[game];

  if (existingId) {
    try {
      await api("PATCH", `/channels/${g.channelId}/messages/${existingId}`, body);
      console.log(`${g.label}: leaderboard message updated.`);
      return;
    } catch (e) {
      if (e.status !== 404) throw e;
      console.warn(`${g.label}: stored message gone; posting a fresh one.`);
    }
  }

  const posted = await api("POST", `/channels/${g.channelId}/messages`, body);
  state.leaderboardMessages = state.leaderboardMessages || {};
  state.leaderboardMessages[game] = posted.id;
  console.log(`${g.label}: leaderboard message posted (id ${posted.id}).`);
}

/* ------------------------------------------------------------------ */
/* Check mode                                                          */
/* ------------------------------------------------------------------ */

async function check() {
  const me = await api("GET", "/users/@me");
  console.log(`Token OK - logged in as ${me.username}#${me.discriminator} (id ${me.id})`);

  const targets = [
    ["mod channel", CONFIG.modChannelId],
    ["log channel", CONFIG.logChannelId],
  ];
  for (const [key, g] of Object.entries(CONFIG.games)) targets.push([key, g.channelId]);

  let failures = 0;
  for (const [label, id] of targets) {
    if (!id) {
      console.warn(`${label}: no channel id configured yet.`);
      continue;
    }
    try {
      const ch = await api("GET", `/channels/${id}`);
      console.log(`${label}: #${ch.name} (id ${id}) reachable.`);
    } catch (e) {
      failures++;
      console.error(`${label}: cannot access channel ${id} -> ${e.message}`);
    }
  }
  if (failures) process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  if (CHECK_ONLY) return check();

  const state = loadState();

  const ctx = {
    data: loadData(),
    changed: new Set(),
    forceRender: FORCE_RENDER,
    lastId: state.modChannelLastMessageId,
    guildId: null,
    nameCache: new Map(),
    systemNotes: [], // failures worth a red run
    warnings: [], // degraded-mode notices; run stays green
    notedKeys: new Set(),

    noteOnce(key, text) {
      if (this.notedKeys.has(key)) return;
      this.notedKeys.add(key);
      this.warnings.push(text);
    },

    /** Mirror a processed command to the log channel. Returns true on success. */
    async log(msg, ok, replies, errors, ping) {
      if (!CONFIG.logChannelId) return false;
      const authorId = msg.author?.id;
      const cmdText = (msg.content || "").trim().slice(0, 1400).replace(/``/g, "`​`");
      const parts = [
        `${ok ? CHECK : CROSS} <@${authorId}> used:`,
        "```\n" + cmdText + "\n```",
      ];
      const detail = [...errors.map((e) => `${CROSS} ${e}`), ...replies].join("\n");
      if (detail) parts.push(detail);
      try {
        await api("POST", `/channels/${CONFIG.logChannelId}/messages`, {
          content: parts.join("\n").slice(0, 1990),
          // mentions render but only ping the author on errors / !help
          allowed_mentions: { parse: [], users: ping && authorId ? [authorId] : [] },
        });
        return true;
      } catch (e) {
        console.warn(`Could not post to log channel: ${e.message}`);
        this.noteOnce(
          "log-fail",
          `Can't post to the log channel <#${CONFIG.logChannelId}> - check View Channel + Send Messages there. Command messages are being left in place.`
        );
        return false;
      }
    },

    /** Delete a processed command message. Returns true on success. */
    async deleteMessage(messageId) {
      try {
        await api("DELETE", `/channels/${CONFIG.modChannelId}/messages/${messageId}`);
        return true;
      } catch (e) {
        console.warn(`Could not delete message ${messageId}: ${e.message}`);
        if (e.status === 403) {
          this.noteOnce(
            "delete-perm",
            "I can't delete command messages in the mod channel - grant me **Manage Messages** there. Falling back to reactions."
          );
        }
        return false;
      }
    },

    async displayName(userId) {
      if (this.nameCache.has(userId)) return this.nameCache.get(userId);
      let name = `User ${userId.slice(-4)}`;
      try {
        if (this.guildId) {
          const m = await api("GET", `/guilds/${this.guildId}/members/${userId}`);
          name = m.nick || m.user?.global_name || m.user?.username || name;
        }
      } catch {
        /* fall through to placeholder; mods can set name: explicitly */
      }
      this.nameCache.set(userId, name);
      return name;
    },

    async react(messageId, emoji) {
      try {
        await api(
          "PUT",
          `/channels/${CONFIG.modChannelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
        );
      } catch (e) {
        console.warn(`Could not react to ${messageId}: ${e.message}`);
      }
    },

    async reply(messageId, content) {
      try {
        await api("POST", `/channels/${CONFIG.modChannelId}/messages`, {
          content: content.slice(0, 1900),
          message_reference: { message_id: messageId },
          allowed_mentions: { parse: [], replied_user: false },
        });
      } catch (e) {
        console.warn(`Could not reply to ${messageId}: ${e.message}`);
      }
    },
  };

  // 1. Poll the mod channel for commands.
  if (CONFIG.modChannelId) {
    try {
      const ch = await api("GET", `/channels/${CONFIG.modChannelId}`);
      ctx.guildId = ch.guild_id || null;
      await pollModChannel(ctx, state);
    } catch (e) {
      console.error(`Mod channel polling failed: ${e.message}`);
      ctx.systemNotes.push(`Mod channel polling failed: ${e.message}`);
    }
  } else {
    console.warn("config.modChannelId is empty - skipping command polling.");
  }

  // Resolve custom server emojis (":name:" entries in tierEmoji) to <:name:id>.
  ctx.emojiMap = new Map();
  const wantsCustom = Object.values(CONFIG.games).some((g) =>
    (g.tierEmoji || []).some((e) => /^:.+:$/.test(e))
  );
  if (wantsCustom) {
    try {
      if (!ctx.guildId) {
        const anyChannel = Object.values(CONFIG.games)[0].channelId;
        const ch = await api("GET", `/channels/${anyChannel}`);
        ctx.guildId = ch.guild_id || null;
      }
      const emojis = await api("GET", `/guilds/${ctx.guildId}/emojis`);
      for (const e of emojis) ctx.emojiMap.set(e.name, e);
      console.log(`Loaded ${ctx.emojiMap.size} server emojis.`);
    } catch (e) {
      ctx.noteOnce(
        "emoji-load",
        `Couldn't load the server emoji list (${e.message.slice(0, 100)}) - rank badges fall back to \u{1F539}.`
      );
    }
  }

  // 2. Persist any data changes for the workflow to commit.
  for (const game of ctx.changed) saveData(game, ctx.data[game]);

  // 3. Re-render leaderboards that need it.
  for (const game of Object.keys(CONFIG.games)) {
    const needs =
      ctx.forceRender || ctx.changed.has(game) || !state.leaderboardMessages?.[game];
    if (!needs) continue;
    try {
      await renderLeaderboard(game, ctx, state);
    } catch (e) {
      console.error(`${game}: render failed: ${e.message}`);
      ctx.systemNotes.push(`${CONFIG.games[game].label} leaderboard update failed: ${e.message}`);
    }
  }

  saveState(state);

  // 4. Surface problems where humans look: log channel first, mod channel as backup.
  const allNotes = [...ctx.systemNotes, ...ctx.warnings];
  if (allNotes.length) {
    const content = `⚠️ **Leaderboard updater:**\n${allNotes.map((n) => `- ${n}`).join("\n")}`.slice(0, 1900);
    for (const chan of [CONFIG.logChannelId, CONFIG.modChannelId].filter(Boolean)) {
      try {
        await api("POST", `/channels/${chan}/messages`, {
          content,
          allowed_mentions: { parse: [] },
        });
        break;
      } catch (e) {
        console.warn(`Could not post notes to ${chan}: ${e.message}`);
      }
    }
  }

  if (ctx.systemNotes.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
