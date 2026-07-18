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

  if (cmd === "help") return { reply: HELP_TEXT };
  if (cmd === "refresh") {
    ctx.forceRender = true;
    return {};
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
  for (const line of lines) {
    try {
      const r = await executeLine(line, ctx);
      if (r.reply) replies.push(r.reply);
    } catch (e) {
      errors.push(lines.length > 1 ? `\`${line.slice(0, 80)}\` -> ${e.message}` : e.message);
    }
  }

  await ctx.react(msg.id, errors.length === 0 ? CHECK : CROSS);
  const parts = [];
  if (errors.length) parts.push(errors.map((e) => `${CROSS} ${e}`).join("\n"));
  if (replies.length) parts.push(replies.join("\n"));
  if (parts.length) await ctx.reply(msg.id, parts.join("\n"));
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
    return String(a.name).localeCompare(String(b.name));
  };
}

function buildEmbed(game, players) {
  const g = CONFIG.games[game];
  const sorted = [...players].sort(compareEntries(game));

  const lines = [];
  sorted.forEach((p, i) => {
    const badge = i === 0 ? "\u{1F947}" : i === 1 ? "\u{1F948}" : i === 2 ? "\u{1F949}" : `**#${i + 1}**`;
    const ts = p.updatedAt ? `<t:${Math.floor(Date.parse(p.updatedAt) / 1000)}:R>` : "-";
    lines.push(`${badge} **${escMd(p.name)}** (<@${p.id}>)`);
    lines.push(`> **${p.rank || "Unranked"}** · Peak: **${p.peak || "-"}** · ${escMd(p.role || "-")} · ${ts}`);
  });

  let description = lines.join("\n");
  if (!sorted.length) {
    description = "*No players tracked yet.*";
  } else if (description.length > 4000) {
    description = description.slice(0, description.lastIndexOf("\n", 3950)) + "\n*…list truncated*";
  }

  return {
    title: `\u{1F3C6} ${g.label} — Leaderboard`,
    color: parseInt(String(g.color).replace(/^#/, ""), 16) || 0x5865f2,
    description,
    footer: { text: `Current rank · Peak · ${g.roleLabel} · Last updated` },
    timestamp: new Date().toISOString(),
  };
}

async function renderLeaderboard(game, ctx, state) {
  const g = CONFIG.games[game];
  const embed = buildEmbed(game, ctx.data[game]);
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

  const targets = [["mod channel", CONFIG.modChannelId]];
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
  const systemNotes = [];

  const ctx = {
    data: loadData(),
    changed: new Set(),
    forceRender: FORCE_RENDER,
    lastId: state.modChannelLastMessageId,
    guildId: null,
    nameCache: new Map(),

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
      systemNotes.push(`Mod channel polling failed: ${e.message}`);
    }
  } else {
    console.warn("config.modChannelId is empty - skipping command polling.");
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
      systemNotes.push(`${CONFIG.games[game].label} leaderboard update failed: ${e.message}`);
    }
  }

  saveState(state);

  // 4. Surface systemic problems in the mod channel so humans notice.
  if (systemNotes.length && CONFIG.modChannelId) {
    try {
      await api("POST", `/channels/${CONFIG.modChannelId}/messages`, {
        content: `⚠️ **Leaderboard updater:**\n${systemNotes.map((n) => `- ${n}`).join("\n")}`.slice(0, 1900),
        allowed_mentions: { parse: [] },
      });
    } catch (e) {
      console.warn(`Could not post system notes: ${e.message}`);
    }
  }

  if (systemNotes.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
