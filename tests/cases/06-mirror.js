// The mirror module: partner boards through webhooks, encryption, self-healing,
// and the hunt for leaked webhook URLs.
const { test, assert, eq, world, leaks, ENV, realCrypto } = T;

const A = "111111111111111111";
const B = "222222222222222222";
const KEY = "test-mirror-key";

const mworld = (opts) => world(Object.assign({ env: { MIRROR_KEY: KEY } }, opts || {}));
const hookCalls = (w, method) => w.discord.callsTo(/^\/webhooks\//, method);
const targets = (w) => w.json("/repo/mirror/targets.json");
const mstate = (w) => w.json("/repo/mirror/state.json");

/** Add a partner through the real path: a mod command, then one run. */
async function partner(w, name, games, extra) {
  const h = w.discord.addWebhook(name + " hook");
  w.modSay(`!mirror add ${h.url} name: ${name} games: ${games || "rivals"}${extra ? " " + extra : ""}`);
  await w.run();
  return h;
}

test("mirror: adding a partner posts the global board on their webhook in the same run", async () => {
  const w = mworld();
  w.modSay(`!add rivals ${A} rank: gm 2 name: Homer\n!add rivals ${B} rank: dia 1 name: Visitor tag: RMR`);
  const h = await partner(w, "p1");
  eq(h.hook.messages.length, 1, "one board on the partner's webhook");
  const msg = h.hook.messages[0];
  const text = JSON.stringify(msg.embeds);
  assert(msg.embeds[0].description.startsWith("# Ladder RO"), msg.embeds[0].description);
  assert(msg.embeds[0].description.includes("Marvel Rivals"), "{game} replaced in the title");
  assert(text.includes(`[${w.config.homeTag}] **Homer**`) && text.includes("[RMR] **Visitor**"), "both communities, tagged");
  assert(!/<@!?\d+>/.test(text), "no mentions on a partner board");
  assert(!msg.components || msg.components.length === 0, "no buttons on a partner board");
  eq(msg.flags, 4096, "posted without a notification");
  eq(mstate(w).p1["marvel-rivals"].messageId, msg.id, "message id remembered");
  assert(/Mirror \*\*p1\*\* added/.test(w.logText()), "confirmed in the log channel");
  eq(w.exitCode, 0);
});

test("mirror: an unchanged board costs zero webhook calls, even on a manual run", async () => {
  const w = mworld();
  await partner(w, "p1");
  w.discord.calls.length = 0;
  await w.run();
  await w.run({ FORCE_RENDER: "true" });
  eq(hookCalls(w).length, 0);
});

test("mirror: a roster change edits the same message in place", async () => {
  const w = mworld();
  const h = await partner(w, "p1");
  const id = h.hook.messages[0].id;
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  eq(h.hook.messages.length, 1);
  eq(h.hook.messages[0].id, id);
  assert(h.hook.messages[0].edited === 1 && JSON.stringify(h.hook.messages[0].embeds).includes("Luna"));
  eq(hookCalls(w, "POST").length, 1, "only the original post");
});

test("mirror: !refresh re-sends every partner board", async () => {
  const w = mworld();
  const h = await partner(w, "p1");
  w.modSay("!refresh");
  await w.run();
  eq(h.hook.messages[0].edited, 1);
});

test("mirror: a board the partner deleted comes back on the next change", async () => {
  const w = mworld();
  const h = await partner(w, "p1");
  h.hook.messages.length = 0;
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  eq(h.hook.messages.length, 1, "posted again");
  eq(mstate(w).p1["marvel-rivals"].messageId, h.hook.messages[0].id);
  eq(w.exitCode, 0);
});

test("mirror: a deleted webhook switches the partner off, says so once, and stops calling it", async () => {
  const w = mworld();
  const h = await partner(w, "p1");
  delete w.discord.webhooks[h.id];
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  eq(w.exitCode, 0, "a partner problem never reddens our run");
  eq([targets(w).p1.hidden, targets(w).p1.disabledReason], [true, "webhook deleted"]);
  assert(/Mirror \*\*p1\*\* switched OFF/.test(w.logText()), "reported in the log channel");
  w.discord.calls.length = 0;
  w.modSay(`!add rivals ${B} rank: gm 1 name: Nova`);
  await w.run();
  eq(hookCalls(w).length, 0, "no more calls to a dead webhook");
  eq((w.logText().match(/switched OFF/g) || []).length, 1, "reported once, not on every run");
});

test("mirror: hide removes the board and keeps the settings; show posts it again", async () => {
  const w = mworld();
  const h = await partner(w, "p1", "rivals", "title: Custom {game}");
  w.modSay("!mirror hide p1");
  await w.run();
  eq(h.hook.messages.length, 0, "board removed");
  eq([targets(w).p1.hidden, targets(w).p1.title], [true, "Custom {game}"]);
  w.modSay("!mirror show p1");
  await w.run();
  eq(h.hook.messages.length, 1, "board back");
  assert(h.hook.messages[0].embeds[0].description.startsWith("# Custom Marvel Rivals"));
});

test("mirror: remove deletes the board and forgets the partner", async () => {
  const w = mworld();
  const h = await partner(w, "p1");
  w.modSay("!mirror remove p1");
  await w.run();
  eq(h.hook.messages.length, 0);
  eq([Object.keys(targets(w)), Object.keys(mstate(w))], [[], []]);
});

test("mirror: changing botname re-posts the board under the new name", async () => {
  const w = mworld();
  const h = await partner(w, "p1");
  const oldId = h.hook.messages[0].id;
  eq(h.hook.messages[0].username, "p1 hook", "partner's own webhook name by default");
  w.modSay("!mirror edit p1 botname: Ladder RO");
  await w.run();
  eq(h.hook.messages.length, 1, "old one deleted, one new");
  assert(h.hook.messages[0].id !== oldId, "it is a new message");
  eq(h.hook.messages[0].username, "Ladder RO");
  w.discord.calls.length = 0;
  await w.run();
  eq(hookCalls(w).length, 0, "and then it settles");
});

test("mirror: editing the game list adds and removes boards", async () => {
  const w = mworld();
  const h = await partner(w, "p1", "rivals");
  w.modSay("!mirror edit p1 games: rivals, ow");
  await w.run();
  eq(h.hook.messages.length, 2);
  w.modSay("!mirror edit p1 games: ow");
  await w.run();
  eq(h.hook.messages.length, 1);
  assert(h.hook.messages[0].embeds[0].description.includes("Overwatch"), "the Overwatch board is the one left");
  eq(Object.keys(mstate(w).p1), ["overwatch"]);
});

test("mirror: 'games: all' and 'default' work", async () => {
  const w = mworld();
  const h = await partner(w, "p1", "all", "title: X {game}");
  eq(h.hook.messages.length, Object.keys(w.config.games).length);
  w.modSay("!mirror edit p1 title: default");
  await w.run();
  eq(targets(w).p1.title, null);
  assert(h.hook.messages.every((m) => m.embeds[0].description.startsWith("# Ladder RO")), "back to the config title");
});

test("mirror: the global board is capped at mirror.maxPlayers and survives a full roster", async () => {
  const w = mworld({ config: (c) => { c.maxPlayers = 0; } });
  const lines = [];
  for (let i = 0; i < 45; i++) lines.push(`!add rivals ${String(700000000000000000n + BigInt(i))} rank: gm ${1 + (i % 3)} name: Player${i} tag: T${i % 9}`);
  w.modSay(lines.join("\n"));
  const h = await partner(w, "p1");
  const first = h.hook.messages[0].embeds[0].fields.filter((f) => f.inline);
  const rows = first.filter((_, i) => i % 3 === 0).reduce((n, f) => n + f.value.split("\n").length, 0);
  eq(rows, w.config.mirror.maxPlayers);
  eq(w.exitCode, 0);
});

test("mirror: thirty partners are served in one run and cost nothing afterwards", async () => {
  const w = mworld();
  const hooks = [];
  for (let i = 0; i < 30; i++) {
    const h = w.discord.addWebhook("hook" + i);
    hooks.push(h);
    w.modSay(`!mirror add ${h.url} name: p${i} games: rivals`);
  }
  await w.run();
  assert(hooks.every((h) => h.hook.messages.length === 1), "every partner got its board");
  eq(Object.keys(targets(w)).length, 30);
  w.discord.calls.length = 0;
  await w.run();
  eq(hookCalls(w).length, 0);
});

test("mirror: a partner outage is a warning, never a red run, and isn't repeated every run", async () => {
  const w = mworld();
  const h = await partner(w, "p1");
  w.discord.fail((m, p) => p.startsWith(`/webhooks/${h.id}/`), Array(40).fill({ status: 500, body: { message: "boom" } }));
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  eq(w.exitCode, 0);
  assert(JSON.stringify(w.board("marvel-rivals")[0].embeds).includes(A), "our own board still updated");
  await w.run({ FORCE_RENDER: "true" });
  eq((w.logText().match(/Mirror \*\*p1\*\* \/ Marvel Rivals/g) || []).length, 1, "one warning for the same failure");
  eq(targets(w).p1.hidden, false, "a temporary failure does not switch the partner off");
});

test("mirror: it recovers by itself once the partner is reachable again", async () => {
  const w = mworld();
  const h = await partner(w, "p1");
  w.discord.fail((m, p) => p.startsWith(`/webhooks/${h.id}/`), Array(4).fill({ status: 500, body: {} }));
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  assert(!JSON.stringify(h.hook.messages[0].embeds).includes("Luna"), "update missed during the outage");
  await w.run();
  assert(JSON.stringify(h.hook.messages[0].embeds).includes("Luna"), "caught up on the next run");
});

// ---- refusing bad input ----

test("mirror: without MIRROR_KEY nothing is stored and the reason is clear", async () => {
  const w = world();
  const h = w.discord.addWebhook("hook");
  w.modSay(`!mirror add ${h.url} name: p1 games: rivals`);
  await w.run();
  eq(Object.keys(targets(w)).length, 0);
  assert(/MIRROR_KEY/.test(w.logText()), "the log explains what is missing");
  eq(leaks(w, [h.token, h.url]), []);
});

test("mirror: a webhook Discord doesn't know is refused at add time", async () => {
  const w = mworld();
  w.modSay("!mirror add https://discord.com/api/webhooks/123456789012345678/NoSuchToken_abc name: ghost games: rivals");
  await w.run();
  eq(Object.keys(targets(w)).length, 0);
  assert(/Discord rejected that webhook/.test(w.logText()));
});

test("mirror: bad commands are refused with a usable message", async () => {
  const w = mworld();
  const h = w.discord.addWebhook("hook");
  w.modSay(["!mirror add name: p1 games: rivals", `!mirror add ${h.url} name: Has Space games: rivals`, `!mirror add ${h.url} name: p1`].join("\n"));
  w.modSay([`!mirror add ${h.url} name: p1 games: chess`, "!mirror edit nobody title: x", "!mirror frobnicate"].join("\n"));
  await w.run();
  const log = w.logText();
  for (const re of [/needs the full webhook URL/, /short `name:`/, /needs `games:`/, /Unknown game "chess"/, /Unknown mirror "nobody"/, /Unknown `!mirror frobnicate`/]) {
    assert(re.test(log), `missing: ${re}`);
  }
  eq(Object.keys(targets(w)).length, 0);
  eq(leaks(w, [h.token, h.url]), []);
});

test("mirror: a second partner can't reuse an existing name", async () => {
  const w = mworld();
  await partner(w, "p1");
  await partner(w, "p1");
  eq(Object.keys(targets(w)).length, 1);
  assert(/already exists/.test(w.logText()));
});

test("mirror: an admin list restricts who may run !mirror", async () => {
  const w = mworld({ config: (c) => { c.mirror.admins = ["900000000000000001"]; } });
  const h = w.discord.addWebhook("hook");
  w.modSay(`!mirror add ${h.url} name: p1 games: rivals`); // typed by the default mod, not on the list
  await w.run();
  eq(Object.keys(targets(w)).length, 0);
  assert(/not on the list/.test(w.logText()));
  w.modSay(`!mirror add ${h.url} name: p1 games: rivals`, { id: "900000000000000001", bot: false });
  await w.run();
  eq(Object.keys(targets(w)).length, 1);
});

// ---- the key ----

test("mirror: with the wrong MIRROR_KEY nothing is sent and nothing breaks", async () => {
  const w = mworld();
  await partner(w, "p1");
  w.discord.calls.length = 0;
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run({ MIRROR_KEY: "a-different-key" });
  eq(hookCalls(w).length, 0);
  eq(w.exitCode, 0);
  assert(/can't be read/.test(w.logText()), "the log says the stored webhook is unreadable");
  assert(targets(w).p1, "the partner is kept, so restoring the key restores the board");
});

test("mirror: a tampered stored URL is rejected, not used", async () => {
  const w = mworld();
  await partner(w, "p1");
  const t = targets(w);
  const parts = t.p1.url.split(":");
  parts[3] = parts[3].slice(0, 6) + (parts[3][6] === "A" ? "B" : "A") + parts[3].slice(7);
  t.p1.url = parts.join(":");
  w.files["/repo/mirror/targets.json"] = JSON.stringify(t);
  w.discord.calls.length = 0;
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  eq(hookCalls(w).length, 0);
  eq(w.exitCode, 0);
});

test(
  "mirror: the stored URL is real AES-256-GCM, decryptable only with the key",
  async () => {
    const w = mworld();
    const h = await partner(w, "p1");
    const [version, iv, tag, body] = targets(w).p1.url.split(":");
    eq(version, "v1");
    eq([ENV.Buffer.from(iv, "base64").length, ENV.Buffer.from(tag, "base64").length], [12, 16], "96-bit IV, 128-bit tag");
    const open = (secret) => {
      const key = ENV.crypto.createHash("sha256").update(secret, "utf8").digest();
      const d = ENV.crypto.createDecipheriv("aes-256-gcm", key, ENV.Buffer.from(iv, "base64"));
      d.setAuthTag(ENV.Buffer.from(tag, "base64"));
      return ENV.Buffer.concat([d.update(ENV.Buffer.from(body, "base64")), d.final()]).toString("utf8");
    };
    eq(open(KEY), h.url, "decrypts back to the webhook URL");
    let failed = false;
    try {
      open("wrong");
    } catch (e) {
      failed = true;
    }
    assert(failed, "the wrong key must not decrypt it");
  },
  { nodeOnly: true }
);

test(
  "mirror: two partners with the same URL get different ciphertexts (fresh IV each time)",
  async () => {
    const w = mworld();
    const h = w.discord.addWebhook("shared");
    w.modSay(`!mirror add ${h.url} name: a1 games: rivals\n!mirror add ${h.url} name: a2 games: rivals`);
    await w.run();
    assert(targets(w).a1.url !== targets(w).a2.url);
  },
  { nodeOnly: true }
);

// ---- secrets ----

test("secrets: after a full partner lifecycle the URL and token exist nowhere in the clear", async () => {
  const w = mworld();
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  const h = await partner(w, "p1", "rivals", "title: T {game} footer: F botname: Bot");
  w.modSay("!mirror list\n!mirror edit p1 games: all\n!mirror hide p1");
  await w.run();
  w.modSay("!mirror show p1\n!refresh");
  await w.run({ FORCE_RENDER: "true" });
  w.discord.fail((m, p) => p.startsWith(`/webhooks/${h.id}/`), [{ status: 500, body: { message: "boom" } }, "network"]);
  w.modSay(`!add rivals ${B} rank: gm 1 name: Nova`);
  await w.run();
  w.modSay("!mirror remove p1");
  await w.run();
  eq(leaks(w, [h.token, h.url]), [], "found in");
  assert(!w.files["/repo/mirror/targets.json"].includes("discord.com"), "targets.json holds no URL");
});

test(
  "secrets: even if Discord echoed the URL back in an error, it is not written anywhere",
  async () => {
    const w = mworld();
    const h = await partner(w, "p1");
    w.discord.fail((m, p) => p.startsWith(`/webhooks/${h.id}/`), Array(4).fill({ status: 400, body: { message: "bad request to " + h.url } }));
    w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
    await w.run();
    eq(leaks(w, [h.token]), [], "found in");
  }
);

test("secrets: the command message carrying the URL is deleted from the mod channel", async () => {
  const w = mworld();
  const h = w.discord.addWebhook("hook");
  const m = w.modSay(`!mirror add ${h.url} name: p1 games: rivals`);
  await w.run();
  assert(!w.discord.channels[w.config.modChannelId].messages.some((x) => x.id === m.id));
  assert(w.logText().includes("[webhook URL hidden]"), "the log shows the placeholder instead");
});

test("secrets: !mirror list shows partners without revealing anything", async () => {
  const w = mworld();
  const h = await partner(w, "p1");
  w.modSay("!mirror list");
  await w.run();
  assert(/\*\*p1\*\* - active - games: marvel-rivals/.test(w.logText()), w.logText().slice(-300));
  eq(leaks(w, [h.token]), []);
});

if (!realCrypto) {
  test("mirror: (local run) encryption above used a stand-in cipher - only the Actions run proves AES", () => {});
}
