/*
 * Test harness. Not a module: both runners evaluate this file with
 *   new Function("ENV", source)(ENV)
 * and get the test API back, so the same code runs under Node (tests/run.js,
 * GitHub Actions) and in headless Edge (tests/run-local.ps1, no Node needed).
 *
 * ENV = { isNode, sources: { update, mirror, config }, fixtures, crypto, Buffer }
 *
 * Nothing here touches the real data/ or mirror/ folders or the real Discord:
 * files live in memory and Discord is the fake below.
 */

const tests = [];
const realSetTimeout = setTimeout;
const strip = (s) => String(s).replace(/^#![^\n]*\n/, "");
const ZW = String.fromCharCode(0x200b);

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || "not equal"}\n      got:      ${String(a).slice(0, 300)}\n      expected: ${String(b).slice(0, 300)}`);
}

async function rejects(fn, re, msg) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`${msg || "expected an error"} - nothing was thrown`);
  if (re && !re.test(err.message)) throw new Error(`${msg || "wrong error"} - got: ${err.message.slice(0, 200)}`);
  return err;
}

/**
 * opts.nodeOnly  - needs Node's real crypto; skipped in the local Edge run.
 * opts.knownBug  - a real defect the test demonstrates but nobody has decided
 *                  to fix yet. It is listed separately and does not fail the
 *                  suite; once it passes, the runner says the mark is stale.
 */
function test(name, fn, opts) {
  tests.push({ name, fn, nodeOnly: !!(opts && opts.nodeOnly), knownBug: (opts && opts.knownBug) || null });
}

/* ------------------------------------------------------------------ */
/* In-memory files                                                     */
/* ------------------------------------------------------------------ */

function normPath(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function memfs(files) {
  const store = {};
  for (const k of Object.keys(files || {})) store[normPath(k)] = files[k];
  return {
    store,
    api: {
      readFileSync(p) {
        const k = normPath(p);
        if (!(k in store)) {
          const e = new Error("ENOENT: " + k);
          e.code = "ENOENT";
          throw e;
        }
        return store[k];
      },
      writeFileSync(p, v) {
        store[normPath(p)] = String(v);
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Browser stand-ins for Node's Buffer and crypto                      */
/*                                                                     */
/* Edge has neither. This toy cipher is NOT AES - it only has the same */
/* shape (key + iv -> ciphertext + tag, wrong key or tampering fails), */
/* so the mirror's logic can run locally. Under Node the real crypto   */
/* module is used, and that is the run that counts for encryption.     */
/* ------------------------------------------------------------------ */

function makeShims() {
  class Buf extends Uint8Array {
    static from(x, enc) {
      if (typeof x === "string") {
        if (enc === "base64") {
          const s = atob(x);
          const b = new Buf(s.length);
          for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
          return b;
        }
        const u = new TextEncoder().encode(x);
        const b = new Buf(u.length);
        b.set(u);
        return b;
      }
      const b = new Buf(x.length);
      b.set(x);
      return b;
    }
    static concat(list) {
      const b = new Buf(list.reduce((n, x) => n + x.length, 0));
      let o = 0;
      for (const x of list) {
        b.set(x, o);
        o += x.length;
      }
      return b;
    }
    toString(enc) {
      if (enc === "base64") {
        let s = "";
        for (const c of this) s += String.fromCharCode(c);
        return btoa(s);
      }
      if (enc === "hex") return Array.from(this, (c) => c.toString(16).padStart(2, "0")).join("");
      return new TextDecoder().decode(this);
    }
  }

  const digest = (bytes) => {
    const out = new Buf(32);
    for (let s = 0; s < 8; s++) {
      let h = (0x811c9dc5 ^ (s * 0x9e3779b1)) >>> 0;
      for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
        h = (h ^ (h >>> 13)) >>> 0;
      }
      h = Math.imul(h ^ bytes.length, 0x85ebca6b) >>> 0;
      out[s * 4] = h >>> 24;
      out[s * 4 + 1] = (h >>> 16) & 255;
      out[s * 4 + 2] = (h >>> 8) & 255;
      out[s * 4 + 3] = h & 255;
    }
    return out;
  };
  const bytesOf = (x) => (typeof x === "string" ? Buf.from(x) : Buf.from(x));
  const stream = (key, iv, data) => {
    const out = new Buf(data.length);
    let block = null;
    for (let i = 0; i < data.length; i++) {
      if (i % 32 === 0) block = digest(Buf.concat([key, iv, Buf.from([i >>> 8, i & 255])]));
      out[i] = data[i] ^ block[i % 32];
    }
    return out;
  };
  const mac = (key, iv, ct) => Buf.from(digest(Buf.concat([Buf.from("mac"), key, iv, ct])).slice(0, 16));

  const crypto = {
    randomBytes(n) {
      const b = new Buf(n);
      for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
      return b;
    },
    createHash() {
      const parts = [];
      const h = {
        update(x) {
          parts.push(bytesOf(x));
          return h;
        },
        digest(enc) {
          const d = digest(Buf.concat(parts));
          return enc ? d.toString(enc) : d;
        },
      };
      return h;
    },
    createCipheriv(alg, key, iv) {
      let ct = new Buf(0);
      return {
        update(x) {
          ct = stream(key, iv, bytesOf(x));
          return ct;
        },
        final: () => new Buf(0),
        getAuthTag: () => mac(key, iv, ct),
      };
    },
    createDecipheriv(alg, key, iv) {
      let tag = null;
      let ct = null;
      return {
        setAuthTag(t) {
          tag = t;
        },
        update(x) {
          ct = bytesOf(x);
          return stream(key, iv, ct);
        },
        final() {
          const want = mac(key, iv, ct);
          if (!tag || want.toString("hex") !== Buf.from(tag).toString("hex")) {
            throw new Error("Unsupported state or unable to authenticate data");
          }
          return new Buf(0);
        },
      };
    },
  };
  return { Buf, crypto };
}

const shims = ENV.crypto ? null : makeShims();
const CRYPTO = ENV.crypto || shims.crypto;
const BUFFER = ENV.Buffer || shims.Buf;

/* ------------------------------------------------------------------ */
/* Discord's embed limits (official docs) - used by the fake below and */
/* directly by the renderer tests.                                     */
/* ------------------------------------------------------------------ */

function embedProblem(body) {
  const embeds = (body && body.embeds) || [];
  if (embeds.length > 10) return "more than 10 embeds";
  let total = 0;
  for (const e of embeds) {
    const count = (s) => {
      total += String(s || "").length;
    };
    if (e.title !== undefined && String(e.title).length > 256) return "title over 256";
    if (e.description !== undefined && String(e.description).length > 4096) return "description over 4096";
    count(e.title);
    count(e.description);
    if (e.footer) {
      if (String(e.footer.text || "").length > 2048) return "footer over 2048";
      count(e.footer.text);
    }
    const fields = e.fields || [];
    if (fields.length > 25) return "more than 25 fields";
    for (const f of fields) {
      const name = String(f.name === undefined ? "" : f.name);
      const value = String(f.value === undefined ? "" : f.value);
      if (!name.trim().length) return "empty field name";
      if (!value.trim().length) return "empty field value";
      if (name.length > 256) return "field name over 256";
      if (value.length > 1024) return `field value over 1024 (${value.length})`;
      count(name);
      count(value);
    }
  }
  if (total > 6000) return `embeds total over 6000 (${total})`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Fake Discord                                                        */
/* ------------------------------------------------------------------ */

function fakeDiscord(config) {
  let next = 1600000000000000000n;
  const newId = () => String(next++);
  const d = {
    botId: "953340420149108837",
    guildId: "1315441635504553994",
    modUser: { id: "244419214738194432", username: "mod", bot: false },
    channels: {},
    emojis: [],
    members: {},
    users: {},
    webhooks: {},
    calls: [],
    rules: [],
    forbidden: new Set(),
  };

  const channel = (id) =>
    d.channels[id] || (d.channels[id] = { id, guild_id: d.guildId, name: "ch-" + String(id).slice(-4), messages: [] });
  [config.modChannelId, config.logChannelId]
    .concat(Object.values(config.games).map((g) => g.channelId))
    .filter(Boolean)
    .forEach(channel);
  if (config.buttonSource && config.buttonSource.channelId) {
    channel(config.buttonSource.channelId).messages.push({
      id: config.buttonSource.messageId,
      content: "",
      author: { id: d.botId, bot: true },
      components: [{ type: 1, components: [{ type: 2, style: 3, label: "Join", custom_id: "join" }] }],
    });
  }
  const names = new Set();
  const collect = (s) => {
    for (const m of String(s || "").matchAll(/:([A-Za-z0-9_~]+):/g)) names.add(m[1]);
  };
  for (const g of Object.values(config.games)) {
    (g.tierEmoji || []).forEach(collect);
    Object.values(g.roleEmoji || {}).forEach(collect);
    collect(g.title);
  }
  [...names].forEach((n, i) => d.emojis.push({ id: String(1500000000000000000n + BigInt(i)), name: n, animated: false }));

  const resp = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (status === 204 ? "" : JSON.stringify(body)),
  });
  const err = (status, code, message) => resp(status, { code, message });

  /** A mod types something in a channel. */
  d.say = (channelId, content, author) => {
    const m = { id: newId(), content, author: author || d.modUser, reactions: [] };
    channel(channelId).messages.push(m);
    return m;
  };
  d.addWebhook = (name, channelId) => {
    const id = newId();
    const token = "tok" + id.slice(-6) + "-SECRET_" + Math.random().toString(36).slice(2, 12);
    d.webhooks[id] = { id, token, name: name || "partner hook", channel_id: channelId || newId(), guild_id: newId(), messages: [] };
    return { id, token, url: `https://discord.com/api/webhooks/${id}/${token}`, hook: d.webhooks[id] };
  };
  /** Make the next matching requests fail: responses are { status, body } or "network". */
  d.fail = (match, responses) => {
    d.rules.push({ match, left: responses.slice() });
  };
  d.callsTo = (re, method) => d.calls.filter((c) => re.test(c.path) && (!method || c.method === method));

  function route(method, path, query, body) {
    let m;
    if (path === "/users/@me") return resp(200, { id: d.botId, username: "Ice Idol", discriminator: "0", bot: true });
    if ((m = path.match(/^\/users\/(\d+)$/))) {
      return d.users[m[1]] ? resp(200, Object.assign({ id: m[1] }, d.users[m[1]])) : err(404, 10013, "Unknown User");
    }
    if ((m = path.match(/^\/guilds\/(\d+)\/emojis$/))) return resp(200, d.emojis);
    if ((m = path.match(/^\/guilds\/(\d+)\/members\/(\d+)$/))) {
      return d.members[m[2]] ? resp(200, d.members[m[2]]) : err(404, 10007, "Unknown Member");
    }

    if ((m = path.match(/^\/channels\/([^/]+)(\/.*)?$/))) {
      const cid = m[1];
      const rest = m[2] || "";
      if (!d.channels[cid]) return err(404, 10003, "Unknown Channel");
      if (d.forbidden.has(cid)) return err(403, 50001, "Missing Access");
      const ch = d.channels[cid];
      if (rest === "" && method === "GET") return resp(200, { id: cid, guild_id: ch.guild_id, name: ch.name });
      if (rest === "/messages" && method === "GET") {
        const q = Object.fromEntries(query.split("&").filter(Boolean).map((p) => p.split("=")));
        let list = ch.messages.slice();
        if (q.after) list = list.filter((x) => BigInt(x.id) > BigInt(q.after));
        list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)); // newest first, like Discord
        if (q.after) list.reverse();
        return resp(200, list.slice(0, Number(q.limit) || 50));
      }
      if (rest === "/messages" && method === "POST") {
        const problem = embedProblem(body);
        if (problem) return err(400, 50035, "Invalid Form Body: " + problem);
        const msg = Object.assign({ id: newId(), author: { id: d.botId, bot: true }, reactions: [] }, body);
        ch.messages.push(msg);
        return resp(200, msg);
      }
      let mm;
      if ((mm = rest.match(/^\/messages\/(\d+)$/))) {
        const i = ch.messages.findIndex((x) => x.id === mm[1]);
        if (i === -1) return err(404, 10008, "Unknown Message");
        if (method === "GET") return resp(200, ch.messages[i]);
        if (method === "PATCH") {
          const problem = embedProblem(body);
          if (problem) return err(400, 50035, "Invalid Form Body: " + problem);
          Object.assign(ch.messages[i], body, { edited: (ch.messages[i].edited || 0) + 1 });
          return resp(200, ch.messages[i]);
        }
        if (method === "DELETE") {
          ch.messages.splice(i, 1);
          return resp(204);
        }
      }
      if ((mm = rest.match(/^\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/)) && method === "PUT") {
        const msg = ch.messages.find((x) => x.id === mm[1]);
        if (!msg) return err(404, 10008, "Unknown Message");
        (msg.reactions = msg.reactions || []).push(decodeURIComponent(mm[2]));
        return resp(204);
      }
    }

    if ((m = path.match(/^\/webhooks\/(\d+)\/([\w-]+)(\/messages\/(\d+))?$/))) {
      const hook = d.webhooks[m[1]];
      if (!hook) return err(404, 10015, "Unknown Webhook");
      if (hook.token !== m[2]) return err(401, 50027, "Invalid Webhook Token");
      if (!m[3]) {
        if (method === "GET") return resp(200, { id: hook.id, name: hook.name, channel_id: hook.channel_id, guild_id: hook.guild_id });
        if (method === "POST") {
          const problem = embedProblem(body);
          if (problem) return err(400, 50035, "Invalid Form Body: " + problem);
          const msg = Object.assign({ id: newId(), webhook_id: hook.id }, body, { username: body.username || hook.name });
          hook.messages.push(msg);
          return /wait=true/.test(query) ? resp(200, msg) : resp(204);
        }
      } else {
        const i = hook.messages.findIndex((x) => x.id === m[4]);
        if (i === -1) return err(404, 10008, "Unknown Message");
        if (method === "PATCH") {
          const problem = embedProblem(body);
          if (problem) return err(400, 50035, "Invalid Form Body: " + problem);
          // Discord ignores username/avatar_url on edits - so does the fake.
          const { username, avatar_url, ...editable } = body;
          Object.assign(hook.messages[i], editable, { edited: (hook.messages[i].edited || 0) + 1 });
          return resp(200, hook.messages[i]);
        }
        if (method === "DELETE") {
          hook.messages.splice(i, 1);
          return resp(204);
        }
      }
    }
    return err(404, 0, `fake Discord has no route for ${method} ${path}`);
  }

  d.fetch = async (url, o) => {
    o = o || {};
    const method = String(o.method || "GET").toUpperCase();
    const full = String(url).replace(/^https:\/\/discord\.com\/api\/v10/, "");
    const cut = full.indexOf("?");
    const path = cut === -1 ? full : full.slice(0, cut);
    const query = cut === -1 ? "" : full.slice(cut + 1);
    const body = o.body ? JSON.parse(o.body) : undefined;
    d.calls.push({ method, path, query, body });
    for (const r of d.rules) {
      if (r.left.length && r.match(method, path)) {
        const x = r.left.shift();
        if (x === "network") throw new TypeError("fetch failed");
        return resp(x.status, x.body || {});
      }
    }
    return route(method, path, query, body);
  };
  return d;
}

/* ------------------------------------------------------------------ */
/* A sandboxed copy of the project                                     */
/* ------------------------------------------------------------------ */

const pathStub = { join: (...a) => a.join("/") };

/**
 * world({ config(cfg), configText, files, env, mirror: false, fetch })
 *   .load()   -> a fresh scripts/update.js instance (its module.exports)
 *   .run()    -> loads a fresh instance and awaits main(), like one workflow run
 *   .files    -> the in-memory file store      .discord -> the fake Discord
 *   .logs     -> everything written to console .delays  -> every sleep requested
 */
function world(opts) {
  opts = opts || {};
  const config = JSON.parse(opts.configText || ENV.sources.config);
  if (opts.config) opts.config(config);
  const fs = memfs(
    Object.assign(
      {
        "/repo/config.json": JSON.stringify(config),
        "/repo/data/state.json": JSON.stringify({ modChannelLastMessageId: "1000", leaderboardMessages: {} }),
        "/repo/mirror/targets.json": "{}",
        "/repo/mirror/state.json": "{}",
      },
      opts.files || {}
    )
  );
  const w = { config, files: fs.store, logs: [], delays: [], discord: opts.discord || fakeDiscord(config), exitCode: 0 };
  const sink = (...a) => w.logs.push(a.map((x) => (x && x.stack ? x.stack : String(x))).join(" "));
  const cons = { log: sink, warn: sink, error: sink };
  const fastTimeout = (fn, ms) => {
    w.delays.push(ms || 0);
    return realSetTimeout(fn, 0);
  };
  const fetchImpl = opts.fetch || w.discord.fetch;
  w.env = Object.assign({ DISCORD_TOKEN: "test-token" }, opts.env || {});

  const instantiate = (src, dirname, req, proc) => {
    const mod = { exports: {} };
    // realTimers: the live test talks to the real Discord and must really wait.
    new Function("require", "module", "__dirname", "process", "console", "fetch", "setTimeout", "Buffer", strip(src))(
      req, mod, dirname, proc, cons, fetchImpl, opts.realTimers ? realSetTimeout : fastTimeout, BUFFER
    );
    return mod.exports;
  };
  const notFound = (m) => {
    const e = new Error(`Cannot find module '${m}'`);
    e.code = "MODULE_NOT_FOUND";
    return e;
  };

  w.loadMirror = (proc) =>
    instantiate(
      ENV.sources.mirror,
      "/repo/mirror",
      (m) => {
        if (m === "fs") return fs.api;
        if (m === "path") return pathStub;
        if (m === "crypto") return CRYPTO;
        throw notFound(m);
      },
      proc || { env: w.env }
    );

  w.load = () => {
    const proc = {
      env: w.env,
      argv: [],
      exitCode: 0,
      exit(code) {
        throw new Error(`process.exit(${code})`);
      },
    };
    const mirrorModule = opts.mirror === false ? null : w.loadMirror(proc);
    const api = instantiate(
      ENV.sources.update,
      "/repo/scripts",
      (m) => {
        if (m === "fs") return fs.api;
        if (m === "path") return pathStub;
        if (m === "../mirror") {
          if (mirrorModule) return mirrorModule;
          throw notFound(m);
        }
        throw notFound(m);
      },
      proc
    );
    api.__proc = proc;
    api.__mirror = mirrorModule;
    return api;
  };

  /** One workflow run. envPatch lets a run be "manual" (FORCE_RENDER) etc. */
  w.run = async (envPatch) => {
    const saved = w.env;
    if (envPatch) w.env = Object.assign({}, w.env, envPatch);
    try {
      const api = w.load();
      await api.main();
      w.exitCode = api.__proc.exitCode;
      return api;
    } finally {
      w.env = saved;
    }
  };

  w.json = (file) => JSON.parse(w.files[normPath(file)]);
  w.roster = (game) => (w.files[`/repo/data/${game}.json`] ? w.json(`/repo/data/${game}.json`) : []);
  w.modSay = (content, author) => w.discord.say(config.modChannelId, content, author);
  w.board = (game) => {
    const ch = w.discord.channels[config.games[game].channelId];
    return ch.messages.filter((m) => m.embeds && m.embeds.length);
  };
  w.logText = () => w.discord.channels[config.logChannelId].messages.map((m) => m.content || "").join("\n---\n");
  return w;
}

/* ------------------------------------------------------------------ */
/* Deterministic sample data                                           */
/* ------------------------------------------------------------------ */

const ROLES = ["Strategist", "Duelist", "Vanguard", "Flex", "flex", "-"];

function ladder(config, game) {
  const g = config.games[game];
  const res = [];
  for (let t = g.tiers.length - 1; t >= 0; t--) {
    const tier = g.tiers[t];
    if ((g.divisionlessTiers || []).includes(tier)) res.push(tier);
    else for (let dv = 1; dv <= Math.min(3, g.divisionCount); dv++) res.push(`${tier} ${dv}`);
  }
  return res;
}

function roster(config, game, n, extra) {
  const ranks = ladder(config, game);
  return Array.from({ length: n }, (_, i) =>
    Object.assign(
      {
        id: String(200000000000000000n + BigInt(i)),
        name: "Player" + i,
        rank: ranks[i % ranks.length],
        peak: ranks[Math.max(0, (i % ranks.length) - 1)],
        role: ROLES[i % ROLES.length],
        updatedAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), 12)).toISOString(),
      },
      extra ? extra(i) : {}
    )
  );
}

function emojiMap(discord) {
  return new Map(discord.emojis.map((e) => [e.name, e]));
}

const noTimestamp = (embed) => {
  const c = JSON.parse(JSON.stringify(embed));
  delete c.timestamp;
  return c;
};

/** Search every place a secret could have leaked to. Returns the places found. */
function leaks(w, secrets) {
  const found = [];
  const look = (where, text) => {
    for (const s of secrets) if (s && String(text).includes(s)) found.push(where);
  };
  look("console", w.logs.join("\n"));
  for (const k of Object.keys(w.files)) look("file " + k, w.files[k]);
  for (const ch of Object.values(w.discord.channels)) look("channel " + ch.name, JSON.stringify(ch.messages));
  for (const h of Object.values(w.discord.webhooks)) look("webhook messages", JSON.stringify(h.messages));
  return found;
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function run() {
  const results = [];
  for (const t of tests) {
    if (t.nodeOnly && !ENV.isNode) {
      results.push({ name: t.name, status: "skipped" });
      continue;
    }
    try {
      await t.fn();
      results.push(
        t.knownBug
          ? { name: t.name, status: "FAILED", error: "marked as a known bug but it passes now - remove the knownBug mark" }
          : { name: t.name, status: "passed" }
      );
    } catch (e) {
      const error = String(e && e.message ? e.message : e).slice(0, 700);
      results.push(
        t.knownBug ? { name: t.name, status: "known-bug", error, note: t.knownBug } : { name: t.name, status: "FAILED", error }
      );
    }
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    passed: count("passed"), failed: count("FAILED"), skipped: count("skipped"), knownBugs: count("known-bug"), results,
  };
}

/** The same plain-text report for both runners. */
function report(r) {
  const lines = [];
  for (const x of r.results) {
    if (x.status === "FAILED") lines.push(`FAIL  ${x.name}\n      ${x.error}`);
  }
  for (const x of r.results) {
    if (x.status === "known-bug") lines.push(`KNOWN BUG  ${x.name}\n      ${x.note}`);
  }
  const skipped = r.results.filter((x) => x.status === "skipped");
  if (skipped.length) {
    lines.push(`skipped here (they need Node's real crypto and run on GitHub Actions): ${skipped.length}`);
  }
  lines.push(
    `${r.failed === 0 ? "OK" : "FAILED"}: ${r.passed} passed, ${r.failed} failed, ${r.knownBugs} known bug(s), ${r.skipped} skipped` +
      ` - ${ENV.isNode ? "Node, real crypto" : "headless Edge, stand-in cipher"}`
  );
  return lines.join("\n");
}

return {
  report,
  test, assert, eq, rejects, run, world, fakeDiscord, embedProblem, roster, ladder, emojiMap,
  noTimestamp, leaks, normPath, ZW, ENV, realCrypto: !!ENV.crypto,
};
