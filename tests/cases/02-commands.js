// Mod commands: add / update / remove, tags, per-community cap, message handling.
const { test, assert, eq, rejects, world } = T;

const A = "111111111111111111";
const B = "222222222222222222";
const C = "333333333333333333";
const D = "444444444444444444";

function setup(configPatch) {
  const w = world({ config: configPatch });
  const api = w.load();
  const ctx = {
    data: Object.fromEntries(Object.keys(api.CONFIG.games).map((g) => [g, []])),
    changed: new Set(),
    displayName: async (id) => "Name" + id.slice(-3),
  };
  const msg = { author: { id: "9" } };
  const run = (line) => api.executeLine(line, ctx, msg);
  const mr = () => ctx.data["marvel-rivals"];
  return { w, api, ctx, run, mr };
}

test("commands: !add stores the player with sensible defaults", async () => {
  const { run, mr, ctx } = setup();
  const r = await run(`!add rivals ${A} rank: gm 2`);
  eq(mr().length, 1);
  const p = mr()[0];
  eq([p.id, p.rank, p.peak, p.role, p.name], [A, "Grandmaster 2", "Grandmaster 2", "-", "Name111"]);
  assert(!("tag" in p), "home players carry no tag field");
  assert(!isNaN(Date.parse(p.updatedAt)), "updatedAt is a date");
  assert(ctx.changed.has("marvel-rivals"), "game marked as changed");
  assert(/Added \*\*Name111\*\*/.test(r.reply) && /#1/.test(r.reply), r.reply);
});

test("commands: an @mention and a bare numeric id are the same player", async () => {
  const { run, mr } = setup();
  await run(`!add rivals <@${A}> rank: gm 2`);
  await run(`!update rivals ${A} rank: gm 1`);
  eq(mr().length, 1);
  eq(mr()[0].rank, "Grandmaster 1");
});

test("commands: a name instead of a mention/id is refused clearly", async () => {
  const { run } = setup();
  await rejects(() => run("!add rivals TESTbOT rank: gm 2"), /needs an @mention/);
});

test("commands: the game can be given as an alias or as its channel id", async () => {
  const { run, ctx, api } = setup();
  await run(`!add mr ${A} rank: gm 2`);
  await run(`!add ${api.CONFIG.games.overwatch.channelId} ${B} rank: master 4`);
  eq(ctx.data["marvel-rivals"].length, 1);
  eq(ctx.data.overwatch[0].rank, "Master 4");
  await rejects(() => run(`!add chess ${A} rank: gm 2`), /Unknown game/);
});

test("commands: role, hero alias, name and peak are stored", async () => {
  const { run, ctx } = setup();
  await run(`!add deadlock ${A} rank: oracle 4 peak: phantom 2 hero: Grey Talon name: Cool Guy`);
  const p = ctx.data.deadlock[0];
  eq([p.rank, p.peak, p.role, p.name], ["Oracle 4", "Phantom 2", "Grey Talon", "Cool Guy"]);
});

test("commands: peak is raised automatically when rank passes it", async () => {
  const { run, mr } = setup();
  await run(`!add rivals ${A} rank: dia 1 peak: dia 1`);
  const r = await run(`!update rivals ${A} rank: gm 3`);
  eq(mr()[0].peak, "Grandmaster 3");
  assert(/peak raised/.test(r.reply), r.reply);
});

test("commands: !add needs a rank; !update needs a known player and a field", async () => {
  const { run } = setup();
  await rejects(() => run(`!add rivals ${A}`), /needs at least/);
  await rejects(() => run(`!update rivals ${A} rank: gm 1`), /not on the/);
  await run(`!add rivals ${A} rank: gm 2`);
  await rejects(() => run(`!update rivals ${A}`), /at least one field/);
});

test("commands: !add on an existing player updates instead of duplicating", async () => {
  const { run, mr } = setup();
  await run(`!add rivals ${A} rank: gm 2`);
  await run(`!add rivals ${A} rank: gm 1`);
  eq(mr().length, 1);
  eq(mr()[0].rank, "Grandmaster 1");
});

test("commands: !remove", async () => {
  const { run, mr } = setup();
  await run(`!add rivals ${A} rank: gm 2`);
  await run(`!remove rivals ${A}`);
  eq(mr().length, 0);
  await rejects(() => run(`!remove rivals ${A}`), /not on the/);
});

test("commands: unknown commands, !help and !refresh", async () => {
  const { run, ctx, api } = setup();
  await rejects(() => run("!frobnicate"), /Unknown command/);
  eq((await run("!help")).reply, api.HELP_TEXT);
  const r = await run("!refresh");
  assert(r.isRefresh && ctx.forceRender === true && ctx.refreshRequested === true, "refresh flags");
});

test("commands: a bad rank changes nothing", async () => {
  const { run, mr } = setup();
  await rejects(() => run(`!add rivals ${A} rank: potato 7`), /Unknown/);
  eq(mr().length, 0);
});

test("tags: stored upper-case, brackets stripped, home tag stored as no tag", async () => {
  const { run, mr, api } = setup();
  await run(`!add rivals ${A} rank: gm 2 tag: rmr`);
  await run(`!add rivals ${B} rank: gm 2 tag: [OWRO]`);
  await run(`!add rivals ${C} rank: gm 2 tag: ${api.CONFIG.homeTag}`);
  const byId = Object.fromEntries(mr().map((p) => [p.id, p]));
  eq(byId[A].tag, "RMR");
  eq(byId[B].tag, "OWRO");
  assert(!("tag" in byId[C]), "home tag is not written to the file");
  assert(api.isHome(byId[C]) && !api.isHome(byId[A]), "isHome");
});

test("tags: invalid tags are refused", async () => {
  const { run, mr } = setup();
  await rejects(() => run(`!add rivals ${A} rank: gm 2 tag: TOOLONG`), /Invalid tag/);
  await rejects(() => run(`!add rivals ${A} rank: gm 2 tag: a b`), /Invalid tag/);
  await rejects(() => run(`!add rivals ${A} rank: gm 2 tag: ro!`), /Invalid tag/);
  eq(mr().length, 0);
});

test("tags: !update can move a player to another community and back home", async () => {
  const { run, mr, api } = setup();
  await run(`!add rivals ${A} rank: gm 2`);
  await run(`!update rivals ${A} tag: RMR`);
  eq(mr()[0].tag, "RMR");
  await run(`!update rivals ${A} tag: ${api.CONFIG.homeTag}`);
  assert(!("tag" in mr()[0]), "back home");
});

test("tags: the reply says which board the player landed on", async () => {
  const { run } = setup();
  assert(/\(#1\)/.test((await run(`!add rivals ${A} rank: gm 2`)).reply), "home position");
  assert(/\[RMR\] global #2/.test((await run(`!add rivals ${B} rank: dia 1 tag: RMR`)).reply), "global position");
});

test("cap: a full community evicts its own bottom player, never another community's", async () => {
  const { run, mr } = setup((c) => {
    c.maxPlayers = 2;
  });
  await run(`!add rivals ${A} rank: gm 2`);
  await run(`!add rivals ${B} rank: gm 1`);
  await run(`!add rivals ${C} rank: bronze 3 tag: RMR`); // far weaker, different community
  const r = await run(`!add rivals ${D} rank: oaa`);
  assert(/dropped off the board/.test(r.reply), r.reply);
  const ids = mr().map((p) => p.id).sort();
  eq(ids, [B, C, D].sort(), "home bottom (A) left; the RMR player stayed");
});

test("cap: an applicant below their own community's cut is refused, roster untouched", async () => {
  const { run, mr } = setup((c) => {
    c.maxPlayers = 2;
  });
  await run(`!add rivals ${A} rank: gm 2 tag: RMR`);
  await run(`!add rivals ${B} rank: gm 1 tag: RMR`);
  await rejects(() => run(`!add rivals ${C} rank: bronze 3 tag: RMR`), /doesn't qualify/);
  eq(mr().length, 2);
  // ...but the same weak rank is fine for a community that still has room
  await run(`!add rivals ${C} rank: bronze 3 tag: OWRO`);
  eq(mr().length, 3);
});

test("cap: 0 means unlimited", async () => {
  const { run, mr } = setup((c) => {
    c.maxPlayers = 0;
  });
  for (let i = 0; i < 40; i++) await run(`!add rivals ${String(500000000000000000n + BigInt(i))} rank: gold 2`);
  eq(mr().length, 40);
});

// ---- message handling ----

function messageSetup() {
  const s = setup();
  const seen = { logged: [], deleted: [], reacted: [], replied: [] };
  Object.assign(s.ctx, {
    botId: "953340420149108837",
    pendingRefresh: [],
    log: async (msg, ok, replies, errors) => {
      seen.logged.push({ ok, replies, errors });
      return true;
    },
    deleteMessage: async (id) => {
      seen.deleted.push(id);
      return true;
    },
    react: async (id, e) => seen.reacted.push([id, e]),
    reply: async (id, c) => seen.replied.push([id, c]),
  });
  const handle = (content, author) =>
    s.api.handleMessage({ id: "77", content, author: author || { id: "9", bot: false } }, s.ctx);
  return Object.assign(s, { seen, handle });
}

test("messages: ordinary chat in the mod channel is left completely alone", async () => {
  const { handle, seen, mr } = messageSetup();
  await handle("hey, can someone add Luna?");
  await handle("notes:\n!add rivals 111111111111111111 rank: gm 2"); // does not OPEN with a command
  eq(mr().length, 0);
  eq([seen.logged.length, seen.deleted.length], [0, 0]);
});

test("messages: several commands in one message all run; one bad line doesn't stop the rest", async () => {
  const { handle, seen, mr } = messageSetup();
  await handle(`!add rivals ${A} rank: gm 2\n!add rivals NOBODY rank: gm 2\n!add rivals ${B} rank: dia 1`);
  eq(mr().length, 2);
  eq(seen.logged.length, 1);
  eq(seen.logged[0].ok, false);
  eq(seen.logged[0].errors.length, 1);
  eq(seen.deleted, ["77"]);
});

test("messages: other bots are ignored, our own bot is obeyed", async () => {
  const { handle, mr } = messageSetup();
  await handle(`!add rivals ${A} rank: gm 2`, { id: "123", bot: true });
  eq(mr().length, 0);
  await handle(`!add rivals ${A} rank: gm 2`, { id: "953340420149108837", bot: true });
  eq(mr().length, 1);
});

test("messages: a webhook URL in a failing line never reaches the log text", async () => {
  const { handle, seen } = messageSetup();
  const url = "https://discord.com/api/webhooks/123456789012345678/AbC-SECRETTOKEN_xyz";
  await handle(`!nonsense ${url}\n!add rivals NOBODY ${url}`);
  const text = JSON.stringify(seen.logged);
  assert(!text.includes("SECRETTOKEN"), "token leaked into the error list: " + text.slice(0, 200));
});
