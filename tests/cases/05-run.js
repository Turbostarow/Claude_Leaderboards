// Whole workflow runs against the fake Discord, including Discord misbehaving.
const { test, assert, eq, world, leaks } = T;

const A = "111111111111111111";
const B = "222222222222222222";
const CHECK = "✅";

const isBoardCall = (w, game) => (method, path) =>
  path.startsWith(`/channels/${w.config.games[game].channelId}/messages`) && (method === "PATCH" || method === "POST");

test("run: a command is read, saved, rendered, logged and cleaned up", async () => {
  const w = world();
  w.discord.members[A] = { nick: "Luna", user: { username: "luna" } };
  const m = w.modSay(`!add rivals <@${A}> rank: gm 2 role: Strategist`);
  await w.run();

  eq(w.exitCode, 0, "run is green");
  eq(w.roster("marvel-rivals").map((p) => [p.id, p.name, p.rank, p.role]), [[A, "Luna", "Grandmaster 2", "Strategist"]]);
  const boards = w.board("marvel-rivals");
  eq(boards.length, 1, "one board message");
  assert(JSON.stringify(boards[0].embeds).includes(`<@${A}>`), "player is on the board");
  assert(boards[0].components && boards[0].components.length === 1, "SCNX buttons copied onto the board");
  assert(/used:/.test(w.logText()) && /Added \*\*Luna\*\*/.test(w.logText()), "outcome mirrored to the log channel");
  assert(!w.discord.channels[w.config.modChannelId].messages.some((x) => x.id === m.id), "command message deleted");
  const state = w.json("/repo/data/state.json");
  eq(state.modChannelLastMessageId, m.id, "poll position advanced");
  eq(Object.keys(state.leaderboardMessages).sort(), Object.keys(w.config.games).sort(), "every game got its board");
});

test("run: a scheduled run with nothing new touches no board", async () => {
  const w = world();
  await w.run();
  w.discord.calls.length = 0;
  await w.run();
  eq(w.discord.calls.filter((c) => /\/messages/.test(c.path) && c.method !== "GET").length, 0, "no writes at all");
});

test("run: a manual run re-renders every board in place, without new messages", async () => {
  const w = world();
  await w.run();
  const before = w.json("/repo/data/state.json").leaderboardMessages;
  await w.run({ FORCE_RENDER: "true" });
  eq(w.json("/repo/data/state.json").leaderboardMessages, before, "same message ids");
  for (const game of Object.keys(w.config.games)) eq(w.board(game).length, 1, `${game} still has one message`);
});

test("run: a board message someone deleted is posted again", async () => {
  const w = world();
  await w.run();
  const ch = w.discord.channels[w.config.games["marvel-rivals"].channelId];
  const old = ch.messages[0].id;
  ch.messages.length = 0;
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  eq(w.board("marvel-rivals").length, 1);
  assert(w.json("/repo/data/state.json").leaderboardMessages["marvel-rivals"] !== old, "state points at the new message");
  eq(w.exitCode, 0);
});

test("run: chat that isn't a command stays in the mod channel", async () => {
  const w = world();
  const m = w.modSay("can someone check Luna's rank?");
  await w.run();
  assert(w.discord.channels[w.config.modChannelId].messages.some((x) => x.id === m.id), "message still there");
  eq(w.json("/repo/data/state.json").modChannelLastMessageId, m.id, "but it is not re-read next time");
});

test("run: the very first run only sets a baseline - old messages are not replayed", async () => {
  const w = world({ files: { "/repo/data/state.json": JSON.stringify({ modChannelLastMessageId: null, leaderboardMessages: {} }) } });
  w.modSay(`!add rivals ${A} rank: gm 2 name: Old`);
  await w.run();
  eq(w.roster("marvel-rivals").length, 0, "history ignored");
  w.modSay(`!add rivals ${B} rank: gm 1 name: New`);
  await w.run();
  eq(w.roster("marvel-rivals").map((p) => p.name), ["New"]);
});

test("run: our board shows home players only; a tagged player is saved but not shown", async () => {
  const w = world();
  w.modSay(`!add rivals ${A} rank: gm 2 name: Homer\n!add rivals ${B} rank: oaa name: Visitor tag: RMR`);
  await w.run();
  eq(w.roster("marvel-rivals").length, 2);
  const text = JSON.stringify(w.board("marvel-rivals")[0].embeds);
  assert(text.includes(A), "home player shown");
  assert(!text.includes(B) && !text.includes("Visitor"), "tagged player must not be on our board");
});

test("run: !refresh re-renders and reports each board in the log", async () => {
  const w = world();
  await w.run();
  w.modSay("!refresh");
  await w.run();
  const log = w.logText();
  for (const g of Object.values(w.config.games)) assert(log.includes(`${g.label}: rendered`), `${g.label} reported`);
});

test("run: a game with no channel of ours (mirror-only) is accepted and never posted", async () => {
  const w = world({
    config: (c) => {
      c.games.r6 = {
        label: "Rainbow Six", aliases: ["r6"], roleLabel: "Role", roleShort: "Role", color: "#2E5C8A",
        tiers: ["Copper", "Bronze", "Silver"], divisionCount: 5, divisionAscending: false,
        divisionStyle: "numeric", divisionlessTiers: [], tierAliases: {},
      };
    },
  });
  w.modSay(`!add r6 ${A} rank: silver 2 name: Ash`);
  await w.run();
  eq(w.roster("r6").map((p) => p.rank), ["Silver 2"]);
  assert(!w.discord.calls.some((c) => c.path.includes("undefined")), "no call to an undefined channel");
  eq(w.exitCode, 0);
});

test("run: without the mirror folder everything works and !mirror is just unknown", async () => {
  const w = world({ mirror: false });
  const hook = "https://discord.com/api/webhooks/123456789012345678/AbC-SECRETTOKEN_xyz";
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  w.modSay(`!mirror add ${hook} name: px games: all`);
  await w.run();
  eq(w.roster("marvel-rivals").length, 1);
  eq(w.board("marvel-rivals").length, 1);
  assert(/Unknown command `!mirror`/.test(w.logText()), "unknown command reported");
  assert(w.logText().includes("[webhook URL hidden]"), "URL redacted in the log");
  eq(leaks(w, ["SECRETTOKEN", hook]), [], "URL/token left behind somewhere");
  eq(w.exitCode, 0);
});

// ---- Discord misbehaving ----

test("failures: one 503 on a board edit is retried and the run stays green", async () => {
  const w = world();
  await w.run();
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  w.discord.fail(isBoardCall(w, "marvel-rivals"), [{ status: 503, body: { message: "upstream connect error" } }]);
  await w.run();
  eq(w.exitCode, 0);
  assert(JSON.stringify(w.board("marvel-rivals")[0].embeds).includes(A), "board updated after the retry");
  assert(w.delays.includes(1000), "waited 1s before retrying");
});

test("failures: a rate limit waits for retry_after and then succeeds", async () => {
  const w = world();
  await w.run();
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  w.discord.fail(isBoardCall(w, "marvel-rivals"), [{ status: 429, body: { retry_after: 2 } }]);
  await w.run();
  eq(w.exitCode, 0);
  assert(w.delays.includes(2500), "waited retry_after + 0.5s, got " + JSON.stringify(w.delays));
});

test("failures: a board that keeps failing reddens the run, is reported, and loses no data", async () => {
  const w = world();
  await w.run();
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  w.discord.fail(isBoardCall(w, "marvel-rivals"), Array(5).fill({ status: 503, body: { message: "down" } }));
  await w.run({ FORCE_RENDER: "true" });
  eq(w.exitCode, 1, "red run so it is noticed");
  eq(w.roster("marvel-rivals").length, 1, "the roster change is still saved");
  assert(/Leaderboard updater/.test(w.logText()) && /Marvel Rivals leaderboard update failed/.test(w.logText()), "reported in the log channel");
  assert(w.board("overwatch")[0].edited >= 1, "the other boards were still rendered");
});

test("failures: an unreachable log channel falls back to a reaction, command still applied", async () => {
  const w = world();
  w.discord.forbidden.add(w.config.logChannelId);
  const m = w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  eq(w.roster("marvel-rivals").length, 1);
  const still = w.discord.channels[w.config.modChannelId].messages.find((x) => x.id === m.id);
  assert(still && still.reactions.includes(CHECK), "command kept and marked with a check");
  assert(w.discord.channels[w.config.modChannelId].messages.some((x) => /Leaderboard updater/.test(x.content || "")), "problem reported in the mod channel instead");
});

test("failures: the emoji list being unavailable degrades to fallback icons, not a crash", async () => {
  const w = world();
  w.discord.fail((m, p) => /\/emojis$/.test(p), [{ status: 403, body: { message: "Missing Access" } }]);
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  eq(w.exitCode, 0);
  assert(JSON.stringify(w.board("marvel-rivals")[0].embeds).includes("\u{1F539}"), "fallback icon used");
  assert(/emoji/i.test(w.logText()), "warning posted");
});

test("failures: a network error on a POST is not replayed (no duplicate messages)", async () => {
  const w = world();
  const logPath = `/channels/${w.config.logChannelId}/messages`;
  w.discord.fail((m, p) => m === "POST" && p === logPath, ["network"]);
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  const attempts = w.discord.calls.filter((c) => c.method === "POST" && c.path === logPath && /used:/.test((c.body && c.body.content) || ""));
  eq(attempts.length, 1, "the command log was sent exactly once");
  eq(w.roster("marvel-rivals").length, 1);
});

test("failures: a network error on a read is retried", async () => {
  const w = world();
  w.discord.fail((m, p) => m === "GET" && p === `/channels/${w.config.modChannelId}`, ["network", "network"]);
  w.modSay(`!add rivals ${A} rank: gm 2 name: Luna`);
  await w.run();
  eq(w.roster("marvel-rivals").length, 1, "command still processed");
  eq(w.exitCode, 0);
});

test("failures: a dead bot token ends in a red run, not an exception", async () => {
  const w = world();
  w.discord.fail(() => true, Array(200).fill({ status: 401, body: { message: "401: Unauthorized" } }));
  await w.run();
  eq(w.exitCode, 1);
});

test("failures: an embed Discord rejects is reported instead of silently dropped", async () => {
  const w = world();
  await w.run();
  w.discord.fail(isBoardCall(w, "deadlock"), [{ status: 400, body: { code: 50035, message: "Invalid Form Body" } }]);
  await w.run({ FORCE_RENDER: "true" });
  eq(w.exitCode, 1);
  assert(/Deadlock leaderboard update failed/.test(w.logText()), "named in the log channel");
});
