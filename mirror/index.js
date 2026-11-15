"use strict";

/*
 * Optional mirror module: posts the GLOBAL leaderboards (every community, rows
 * shown as "[TAG] Name") to webhooks on other Discord servers. The bot is never
 * invited there - a webhook URL is all a partner hands over.
 *
 * scripts/update.js loads this folder if it exists; delete the folder and the
 * main script behaves exactly as it did before.
 *
 *   command(rest, env, msg)   handles "!mirror ..." lines from the mod channel
 *   sync(env, { force })      brings every partner message up to date
 *
 * A webhook URL is a credential and this repo is public, so URLs are stored
 * only encrypted (AES-256-GCM, key derived from the MIRROR_KEY secret) and are
 * never written to a log, an error message or a reply.
 *
 * Node built-ins only.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TARGETS_PATH = path.join(__dirname, "targets.json");
const STATE_PATH = path.join(__dirname, "state.json");
const API = "https://discord.com/api/v10";

const HOOK_RE = /https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/(\d+)\/([\w-]+)/i;
const HOOK_RE_ALL = new RegExp(HOOK_RE.source, "gi");
const redact = (s) => String(s).replace(HOOK_RE_ALL, "[webhook URL hidden]");

const UNKNOWN_WEBHOOK = 10015; // the partner deleted the webhook
const INVALID_WEBHOOK_TOKEN = 50027;
const SUPPRESS_NOTIFICATIONS = 4096; // message flag: a board is not an announcement
const OPTION_KEYS = ["name", "games", "title", "footer", "botname", "avatar"];
const DEFAULT_TITLE = "Ladder RO - {game}";
const PAUSE_MS = 250; // spacing between webhook calls when there are many partners

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/* ------------------------------------------------------------------ */
/* Encryption                                                          */
/* ------------------------------------------------------------------ */

function secretKey() {
  const secret = (process.env.MIRROR_KEY || "").trim();
  // Hashing lets MIRROR_KEY be any string; AES-256 needs exactly 32 bytes.
  return secret ? crypto.createHash("sha256").update(secret, "utf8").digest() : null;
}

function requireKey() {
  const key = secretKey();
  if (!key) {
    throw new Error(
      "The `MIRROR_KEY` secret is not set in the repository (Settings -> Secrets -> Actions), so webhook URLs can't be stored."
    );
  }
  return key;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", requireKey(), iv);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

function decrypt(blob) {
  const [version, iv, tag, body] = String(blob).split(":");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("unreadable stored webhook");
  const decipher = crypto.createDecipheriv("aes-256-gcm", requireKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

function parseHook(url) {
  const m = String(url).match(HOOK_RE);
  if (!m) throw new Error("not a Discord webhook URL");
  return { id: m[1], token: m[2] };
}

/* ------------------------------------------------------------------ */
/* Webhook HTTP                                                        */
/* ------------------------------------------------------------------ */

/** Errors raised here never contain the URL or the token. */
async function hookRequest(method, hook, suffix, body) {
  const url = `${API}/webhooks/${hook.id}/${hook.token}${suffix}`;
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const lastTry = attempt === attempts - 1;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // A POST that failed at network level may still have landed; replaying
      // it could leave two boards in the partner's channel.
      if (lastTry || method === "POST") throw new Error(`${method} webhook -> network error`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429) {
      const info = await res.json().catch(() => ({}));
      await sleep(Math.ceil(((info.retry_after ?? 1) + 0.5) * 1000));
      continue;
    }
    if (res.status >= 500 && !lastTry) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const detail = json && json.message ? `: ${String(json.message).slice(0, 150)}` : "";
      const err = new Error(`${method} webhook -> HTTP ${res.status}${detail}`);
      err.status = res.status;
      err.code = json ? json.code : undefined;
      throw err;
    }
    return json;
  }
  throw new Error(`${method} webhook -> gave up after repeated rate limits`);
}

const isDeadWebhook = (e) =>
  (e.status === 404 && e.code === UNKNOWN_WEBHOOK) ||
  (e.status === 401 && e.code === INVALID_WEBHOOK_TOKEN);

async function deleteMessage(hook, messageId) {
  if (!messageId) return;
  try {
    await hookRequest("DELETE", hook, `/messages/${messageId}`);
  } catch (e) {
    if (e.status !== 404) throw e; // already gone is fine
  }
}

/* ------------------------------------------------------------------ */
/* Command parsing                                                     */
/* ------------------------------------------------------------------ */

function parseOptions(text) {
  const out = {};
  const re = new RegExp(`\\b(${OPTION_KEYS.join("|")})\\s*:`, "gi");
  const matches = [...text.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1].toLowerCase();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const value = text.slice(start, end).trim();
    if (value) out[key] = value;
  }
  return out;
}

function slug(input) {
  const name = String(input || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error(
      "A mirror needs a short `name:` (letters, digits, `-` or `_`, no spaces), e.g. `name: partner-x`."
    );
  }
  return name;
}

function parseGames(value, env) {
  const all = Object.keys(env.CONFIG.games);
  if (String(value).trim().toLowerCase() === "all") return all;
  const games = [];
  for (const token of String(value).split(/[,\s]+/).filter(Boolean)) {
    const game = env.resolveGame(token);
    if (!games.includes(game)) games.push(game);
  }
  if (!games.length) throw new Error("`games:` is empty - e.g. `games: rivals, ow` or `games: all`.");
  return games;
}

/** "default" or "-" clears an optional setting back to the config default. */
const clearable = (v) => (/^(default|-)$/i.test(String(v).trim()) ? null : String(v).trim());
const cleanUrl = (v) => String(v).trim().replace(/^<|>$/g, "");
const labels = (games, env) => games.map((g) => env.CONFIG.games[g].label).join(", ");

const HELP = [
  "**Partner boards (mirror)** - the global leaderboards, sent to a webhook on another server.",
  "```",
  "!mirror add <webhook-url> name: <partner> games: <games|all> [title: ...] [footer: ...] [botname: ...] [avatar: <url>]",
  "!mirror edit <partner> [games: ...] [title: ...] [footer: ...] [botname: ...] [avatar: ...]",
  "!mirror hide <partner>     remove its board(s) but keep the settings",
  "!mirror show <partner>     post them again",
  "!mirror remove <partner>   delete the partner and its board(s)",
  "!mirror list",
  "```",
  "`title:` may contain `{game}`. `default` clears an optional setting (e.g. `title: default`).",
  "Changing `botname`/`avatar` re-posts the board, because Discord fixes them when a message is sent.",
  "The webhook URL is stored encrypted and this command message is deleted after it runs.",
].join("\n");

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdAdd(args, env, authorId) {
  const m = args.match(HOOK_RE);
  if (!m) throw new Error("`!mirror add` needs the full webhook URL. Try `!mirror help`.");
  const opts = parseOptions(args.replace(m[0], " "));
  const name = slug(opts.name);
  const targets = readJson(TARGETS_PATH);
  if (targets[name]) {
    throw new Error(`A mirror named **${name}** already exists - use \`!mirror edit ${name} ...\` or another name.`);
  }
  if (!opts.games) throw new Error("`!mirror add` needs `games:` (e.g. `games: rivals, ow` or `games: all`).");
  const games = parseGames(opts.games, env);
  requireKey();

  let info;
  try {
    info = await hookRequest("GET", { id: m[1], token: m[2] }, "");
  } catch (e) {
    throw new Error(`Discord rejected that webhook (${e.message}). Check the URL is complete and the webhook still exists.`);
  }

  targets[name] = {
    url: encrypt(m[0]),
    games,
    title: opts.title ? clearable(opts.title) : null,
    footer: opts.footer ? clearable(opts.footer) : null,
    botname: opts.botname ? clearable(opts.botname) : null,
    avatar: opts.avatar ? clearable(cleanUrl(opts.avatar)) : null,
    hidden: false,
    addedBy: authorId || null,
    addedAt: new Date().toISOString(),
  };
  writeJson(TARGETS_PATH, targets);
  const hookName = info && info.name ? ` (webhook "${env.escMd(info.name)}")` : "";
  return { reply: `Mirror **${name}** added${hookName} for ${labels(games, env)}. Its board is posted in this same run.` };
}

function loadTarget(args) {
  const name = String(args.split(/\s+/)[0] || "").toLowerCase();
  const targets = readJson(TARGETS_PATH);
  if (!name || !targets[name]) {
    const known = Object.keys(targets);
    throw new Error(
      `Unknown mirror "${name || "?"}".` + (known.length ? ` Known: ${known.join(", ")}.` : " There are none yet.")
    );
  }
  return { name, targets, target: targets[name], rest: args.slice(name.length).trim() };
}

async function cmdEdit(args, env) {
  const { name, targets, target, rest } = loadTarget(args);
  const opts = parseOptions(rest);
  delete opts.name; // the name is the key; renaming is remove + add
  if (!Object.keys(opts).length) {
    throw new Error("`!mirror edit` needs at least one of: games / title / footer / botname / avatar.");
  }
  if (opts.games) target.games = parseGames(opts.games, env);
  if (opts.title) target.title = clearable(opts.title);
  if (opts.footer) target.footer = clearable(opts.footer);
  if (opts.botname) target.botname = clearable(opts.botname);
  if (opts.avatar) target.avatar = clearable(cleanUrl(opts.avatar));
  writeJson(TARGETS_PATH, targets);
  return { reply: `Mirror **${name}** updated (${Object.keys(opts).join(", ")}). Applied in this same run.` };
}

async function cmdVisibility(args, hidden) {
  const { name, targets, target } = loadTarget(args);
  target.hidden = hidden;
  delete target.disabledReason;
  writeJson(TARGETS_PATH, targets);
  return {
    reply: hidden
      ? `Mirror **${name}** hidden - its board is removed in this run, settings are kept.`
      : `Mirror **${name}** is active again - its board is posted in this run.`,
  };
}

async function cmdRemove(args) {
  const { name, targets, target } = loadTarget(args);
  const state = readJson(STATE_PATH);
  let leftover = false;
  try {
    const hook = parseHook(decrypt(target.url));
    for (const entry of Object.values(state[name] || {})) await deleteMessage(hook, entry.messageId);
  } catch {
    leftover = Object.keys(state[name] || {}).length > 0;
  }
  delete targets[name];
  delete state[name];
  writeJson(TARGETS_PATH, targets);
  writeJson(STATE_PATH, state);
  return {
    reply:
      `Mirror **${name}** removed.` +
      (leftover ? " Its board message could not be deleted - remove it by hand on that server." : ""),
  };
}

function cmdList() {
  const targets = readJson(TARGETS_PATH);
  const names = Object.keys(targets);
  if (!names.length) {
    return { reply: "No mirrors yet. Add one: `!mirror add <webhook-url> name: <partner> games: <games>`." };
  }
  const lines = names.map((name) => {
    const t = targets[name];
    const status = t.hidden ? (t.disabledReason ? `OFF (${t.disabledReason})` : "hidden") : "active";
    const extras = [
      t.title ? `title: ${t.title}` : "",
      t.botname ? `botname: ${t.botname}` : "",
      t.avatar ? "custom avatar" : "",
    ].filter(Boolean);
    return `- **${name}** - ${status} - games: ${(t.games || []).join(", ")}${extras.length ? ` - ${extras.join(" - ")}` : ""}`;
  });
  return { reply: `**Mirrors (${names.length})**\n${lines.join("\n")}` };
}

async function command(rest, env, msg) {
  const cfg = env.CONFIG.mirror || {};
  const admins = (cfg.admins || []).map(String);
  const authorId = String((msg && msg.author && msg.author.id) || "");
  // An empty list means every mod in the channel may manage mirrors.
  if (admins.length && !admins.includes(authorId)) {
    throw new Error("You are not on the list allowed to run `!mirror` commands.");
  }

  const sub = (rest.split(/\s+/)[0] || "help").toLowerCase();
  const args = rest.slice(sub.length).trim();
  try {
    if (sub === "help") return { reply: HELP, ping: true };
    if (sub === "list") return cmdList();
    if (sub === "add") return await cmdAdd(args, env, authorId);
    if (sub === "edit") return await cmdEdit(args, env);
    if (sub === "hide") return await cmdVisibility(args, true);
    if (sub === "show") return await cmdVisibility(args, false);
    if (sub === "remove") return await cmdRemove(args);
    throw new Error(`Unknown \`!mirror ${sub}\`. Try \`!mirror help\`.`);
  } catch (e) {
    e.message = redact(e.message);
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

function buildPayload(env, target, game) {
  const cfg = env.CONFIG.mirror || {};
  const g = env.CONFIG.games[game];
  const max = Number(cfg.maxPlayers) || 32;
  // The global board: every community, best first.
  const players = [...(env.ctx.data[game] || [])].sort(env.compareEntries(game)).slice(0, max);
  const title = String(target.title || cfg.title || DEFAULT_TITLE).replace(/\{game\}/gi, g.label);
  const embed = env.buildEmbed(game, players, env.ctx, {
    names: "tagged",
    nameMax: cfg.nameMax,
    roleStyle: cfg.roleStyle,
    title,
    footer: target.footer || cfg.footer || null,
  });
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}

/** Create or update one board. Returns true when Discord was actually called. */
async function upsert(env, target, hook, game, boards, force) {
  const payload = buildPayload(env, target, game);
  // The embed timestamp changes every run; leave it out of the comparison.
  const { timestamp, ...stable } = payload.embeds[0];
  const hash = crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  const identity = `${target.botname || ""}|${target.avatar || ""}`;
  const cur = boards[game];

  if (cur && cur.messageId) {
    if (cur.identity === identity) {
      if (cur.hash === hash && !force) return false;
      try {
        await hookRequest("PATCH", hook, `/messages/${cur.messageId}`, payload);
        cur.hash = hash;
        return true;
      } catch (e) {
        // Only "the message is gone" falls through to a fresh post.
        if (e.status !== 404 || e.code === UNKNOWN_WEBHOOK) throw e;
      }
    } else {
      // Name/avatar are fixed when a message is sent - replace the message.
      await deleteMessage(hook, cur.messageId);
    }
  }

  const body = { ...payload, flags: SUPPRESS_NOTIFICATIONS };
  if (target.botname) body.username = target.botname;
  if (target.avatar) body.avatar_url = target.avatar;
  const posted = await hookRequest("POST", hook, "?wait=true", body);
  boards[game] = { messageId: posted.id, hash, identity };
  return true;
}

async function sync(env, opts) {
  const force = !!(opts && opts.force);
  const targets = readJson(TARGETS_PATH);
  const names = Object.keys(targets);
  if (!names.length) return;

  const note = (key, text) => env.ctx.noteOnce(`mirror-${key}`, text);
  if (!secretKey()) {
    note("key", "Mirror: the `MIRROR_KEY` secret is not set, so partner boards are not being updated.");
    return;
  }

  const state = readJson(STATE_PATH);
  const before = JSON.stringify([targets, state]);
  let calls = 0;

  for (const name of names) {
    const target = targets[name];
    let hook;
    try {
      hook = parseHook(decrypt(target.url));
    } catch {
      note(`key-${name}`, `Mirror **${name}**: its stored webhook can't be read (was \`MIRROR_KEY\` changed?). Remove it and add it again.`);
      continue;
    }

    const boards = state[name] || (state[name] = {});
    const wanted = target.hidden ? [] : (target.games || []).filter((g) => env.CONFIG.games[g]);

    try {
      // Boards that should no longer exist: hidden partner or a game taken off its list.
      for (const game of Object.keys(boards)) {
        if (wanted.includes(game)) continue;
        await deleteMessage(hook, boards[game].messageId);
        delete boards[game];
        calls++;
        await sleep(PAUSE_MS);
      }
      for (const game of wanted) {
        try {
          if (await upsert(env, target, hook, game, boards, force)) {
            calls++;
            await sleep(PAUSE_MS);
          }
          if (boards[game]) delete boards[game].error;
        } catch (e) {
          if (isDeadWebhook(e)) throw e;
          // Report a persistent failure once, not on every run.
          const slot = boards[game] || (boards[game] = {});
          if (slot.error !== e.message) {
            slot.error = e.message;
            env.ctx.warnings.push(`Mirror **${name}** / ${env.CONFIG.games[game].label}: ${redact(e.message)}`);
          }
        }
      }
    } catch (e) {
      if (isDeadWebhook(e)) {
        target.hidden = true;
        target.disabledReason = "webhook deleted";
        state[name] = {};
        env.ctx.warnings.push(
          `Mirror **${name}** switched OFF: its webhook no longer exists on the partner's server. \`!mirror remove ${name}\` or add a new one.`
        );
      } else {
        note(`fail-${name}`, `Mirror **${name}**: ${redact(e.message)}`);
      }
    }
  }

  if (JSON.stringify([targets, state]) !== before) {
    writeJson(TARGETS_PATH, targets);
    writeJson(STATE_PATH, state);
  }
  console.log(`Mirror: ${names.length} partner(s), ${calls} webhook call(s).`);
}

module.exports = { command, sync, redact };
