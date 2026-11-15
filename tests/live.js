#!/usr/bin/env node
"use strict";

/*
 * LIVE test: drives the real mirror module against a real Discord webhook
 * (the TEST_WEBHOOK_URL secret - a channel on a test server). Started by hand
 * from the "Live test" workflow; never part of the normal suite.
 *
 * It uses its own in-memory files and its own throwaway key, so it cannot
 * touch the real partner list, the real rosters or MIRROR_KEY.
 *
 *   KEEP=true   leave the final 32-row board in the channel to look at
 *   DISCORD_TOKEN (optional) only to read the server's emoji list, so the
 *                 board shows the real rank/role emojis
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOOK = (process.env.TEST_WEBHOOK_URL || "").trim();
const KEEP = String(process.env.KEEP || "").toLowerCase() === "true";
const TOKEN = (process.env.DISCORD_TOKEN || "").trim();

if (!/\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+/.test(HOOK)) {
  console.error("TEST_WEBHOOK_URL is missing or is not a Discord webhook URL (repo Settings -> Secrets -> Actions).");
  process.exit(2);
}

const ENV = {
  isNode: true,
  crypto: require("crypto"),
  Buffer,
  sources: { update: read("scripts", "update.js"), mirror: read("mirror", "index.js"), config: read("config.json") },
  fixtures: {},
};
const T = new Function("ENV", read("tests", "lib", "harness.js"))(ENV);

async function main() {
  const w = T.world({ fetch: (u, o) => fetch(u, o), realTimers: true, env: { MIRROR_KEY: "live-test-throwaway-key" } });
  const api = w.load();
  const mirror = api.__mirror;
  const safe = (s) => api.redactWebhooks(String(s));
  const game = "marvel-rivals";
  let step = 0;
  const ok = (text) => console.log(`ok ${++step} - ${text}`);

  // Real emojis if we can read them; otherwise the board shows fallback icons.
  const emojiMap = new Map();
  if (TOKEN) {
    try {
      const get = async (route) => {
        const r = await fetch("https://discord.com/api/v10" + route, { headers: { Authorization: `Bot ${TOKEN}` } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      };
      const ch = await get(`/channels/${api.CONFIG.games[game].channelId}`);
      for (const e of await get(`/guilds/${ch.guild_id}/emojis`)) emojiMap.set(e.name, e);
      console.log(`# loaded ${emojiMap.size} server emojis`);
    } catch (e) {
      console.log(`# could not load server emojis (${e.message}) - fallback icons will show`);
    }
  }

  const warnings = [];
  const data = Object.fromEntries(Object.keys(api.CONFIG.games).map((g) => [g, []]));
  const env = {
    CONFIG: api.CONFIG,
    ctx: { data, warnings, emojiMap, noteOnce: (k, t) => warnings.push(t) },
    buildEmbed: api.buildEmbed, compareEntries: api.compareEntries, resolveGame: api.resolveGame,
    escMd: api.escMd, redactWebhooks: api.redactWebhooks,
  };
  const author = { author: { id: "1" } };
  const cmd = async (line) => (await mirror.command(line, env, author)).reply;
  const state = () => (w.json("/repo/mirror/state.json").live || {})[game] || {};
  const fetchMessage = async (id) => {
    const r = await fetch(`${HOOK.split("?")[0]}/messages/${id}`);
    return { status: r.status, body: r.ok ? await r.json() : null };
  };
  const sync = async (force) => {
    await mirror.sync(env, { force: !!force });
    if (warnings.length) throw new Error("mirror reported: " + safe(warnings.join(" | ")));
    await sleep(700); // stay far away from the webhook rate limit
  };
  const rows = (msg) => {
    const f = msg.embeds[0].fields.filter((x) => x.inline);
    let n = 0;
    for (let i = 0; i < f.length; i += 3) n += f[i].value.split("\n").filter((l) => /^\*\*#\d+\*\*/.test(l)).length;
    return n;
  };
  // Long names and 5-character tags on purpose: this is the layout stress case.
  const players = (n) =>
    T.roster(w.config, game, n, (i) => ({
      name: ["Turbostar", "LongPlayerName" + i, "Zack", "xX_Shadow_Xx" + i][i % 4],
      tag: ["BLDRO", "RMRIV", "OWRO", "DLK"][i % 4],
      role: ["Strategist", "Duelist", "Vanguard", "Flex"][i % 4],
    }));

  const reply = await cmd(`add ${HOOK} name: live games: rivals title: LIVE TEST - {game}`);
  if (!/added/.test(reply)) throw new Error("add failed: " + safe(reply));
  ok("Discord accepted the webhook and the URL was stored encrypted");
  if (w.files["/repo/mirror/targets.json"].includes("discord.com")) throw new Error("targets.json contains a plain URL");
  ok("the stored partner file holds no plain URL");

  let lastId = null;
  for (const n of [1, 16, 17, 32]) {
    data[game] = players(n);
    await sync();
    const id = state().messageId;
    const got = await fetchMessage(id);
    if (got.status !== 200) throw new Error(`board with ${n} rows: message not found (HTTP ${got.status})`);
    if (rows(got.body) !== n) throw new Error(`board with ${n} rows: Discord shows ${rows(got.body)}`);
    if (lastId && id !== lastId) throw new Error(`board with ${n} rows was re-posted instead of edited in place`);
    lastId = id;
    ok(`${n}-row board ${n === 1 ? "posted" : "edited in place"} and read back from Discord`);
  }

  await sync();
  ok("an unchanged board is left alone");

  await cmd("edit live botname: Ladder RO (live test)");
  await sync();
  const renamed = state().messageId;
  if (renamed === lastId) throw new Error("changing botname did not re-post the board");
  if ((await fetchMessage(lastId)).status !== 404) throw new Error("the old board was not deleted after the rename");
  const shown = (await fetchMessage(renamed)).body;
  if (!shown || shown.author.username !== "Ladder RO (live test)") throw new Error("the new board does not carry the new name");
  ok("changing botname deleted the old board and posted a new one under the new name");

  await cmd("hide live");
  await sync();
  if ((await fetchMessage(renamed)).status !== 404) throw new Error("hide did not delete the board");
  ok("hide removed the board");

  await cmd("show live");
  await sync();
  const back = state().messageId;
  if ((await fetchMessage(back)).status !== 200) throw new Error("show did not post the board again");
  ok("show posted it again");

  if (KEEP) {
    console.log("# KEEP=true: the 32-row board stays in the test channel - check the width with 5-char tags and the gap after #16.");
  } else {
    await cmd("remove live");
    await sleep(700);
    if ((await fetchMessage(back)).status !== 404) throw new Error("remove did not delete the board");
    ok("remove deleted the board");
  }

  const leaked = T.leaks(w, [HOOK, HOOK.split("/").pop()]);
  if (leaked.length) throw new Error("webhook URL or token found in: " + leaked.join(", "));
  ok("no URL or token in any file or log line");
  console.log(`LIVE TEST PASSED (${step} checks)`);
}

main().catch((e) => {
  const text = String(e && e.message ? e.message : e).split(HOOK).join("[webhook URL hidden]");
  console.error("LIVE TEST FAILED: " + text.replace(/webhooks\/\d+\/[\w-]+/g, "webhooks/[hidden]"));
  process.exit(1);
});
