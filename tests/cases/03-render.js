// The board renderer: Discord's limits, bands, the two views, v1.0 regression,
// sorting, and the invisible characters the layout depends on.
const { test, assert, eq, world, roster, emojiMap, embedProblem, noTimestamp, ZW, ENV } = T;

const w = world();
const api = w.load();
const ctx = { emojiMap: emojiMap(w.discord) };
const games = Object.keys(api.CONFIG.games);
const GLOBAL = { names: "tagged", nameMax: 12, roleStyle: "icon", title: "Ladder RO - {game}", footer: "Global footer" };
const GLOBAL_TEXT = { names: "tagged", nameMax: 12, roleStyle: "text", title: "Ladder" };

const inline = (e) => (e.fields || []).filter((f) => f.inline);
const rowsIn = (e) => {
  const f = inline(e);
  let n = 0;
  for (let i = 0; i < f.length; i += 3) n += f[i].value.split("\n").length;
  return n;
};
const worst = (game) => (i) => {
  const g = api.CONFIG.games[game];
  const longestTier = g.tiers.reduce((a, b) => ((g.tierShort || g.tiers)[g.tiers.indexOf(b)].length > (g.tierShort || g.tiers)[g.tiers.indexOf(a)].length ? b : a));
  const rank = (g.divisionlessTiers || []).includes(longestTier) ? longestTier : `${longestTier} 1`;
  return { rank, peak: rank, role: "Strategist*_~`|", name: "W".repeat(28) + "*_~" + i, tag: "WWWWW" };
};

// ---- Discord's hard limits, as a property over many rosters ----

for (const game of games) {
  test(`limits/${game}: no roster size or content can produce an embed Discord would reject`, () => {
    for (const n of [0, 1, 2, 5, 15, 16, 17, 31, 32, 33, 48, 60, 120]) {
      for (const [label, extra] of [["normal", null], ["worst-case", worst(game)]]) {
        const players = roster(w.config, game, n, extra);
        for (const [viewName, view] of [["home", undefined], ["global-icon", GLOBAL], ["global-text", GLOBAL_TEXT]]) {
          const embed = api.buildEmbed(game, players, ctx, view);
          const problem = embedProblem({ embeds: [embed] });
          assert(!problem, `${n} players, ${label}, ${viewName}: ${problem}`);
        }
      }
    }
  });
}

test("limits: up to 32 players nobody is dropped from the board", () => {
  for (const game of games) {
    for (const n of [1, 16, 17, 32]) {
      for (const extra of [null, worst(game)]) {
        const e = api.buildEmbed(game, roster(w.config, game, n, extra), ctx);
        eq(rowsIn(e), n, `${game} with ${n} players`);
        assert(!/truncated/.test(e.description), "no truncation note");
      }
    }
  }
});

test("limits: an absurd roster is trimmed with a visible note instead of failing", () => {
  const e = api.buildEmbed("marvel-rivals", roster(w.config, "marvel-rivals", 200), ctx);
  assert(/truncated/.test(e.description), "truncation note present");
  assert(rowsIn(e) < 200 && rowsIn(e) >= 32, `kept ${rowsIn(e)} rows`);
});

// ---- bands ----

test("bands: 16 players are one band, the 17th opens a second band in the same embed", () => {
  const e16 = api.buildEmbed("marvel-rivals", roster(w.config, "marvel-rivals", 16), ctx);
  const e17 = api.buildEmbed("marvel-rivals", roster(w.config, "marvel-rivals", 17), ctx);
  eq(inline(e16).length, 3);
  eq(inline(e17).length, 6);
  eq(inline(e17).map((f) => f.value.split("\n").length), [16, 16, 16, 1, 1, 1]);
  eq(inline(e17).slice(3).map((f) => f.name), [ZW, ZW, ZW], "later bands use invisible headers");
  assert(inline(e17).slice(0, 3).every((f) => f.name !== ZW), "first band has real headers");
});

test("bands: positions keep counting across the seam", () => {
  const e = api.buildEmbed("marvel-rivals", roster(w.config, "marvel-rivals", 20), ctx);
  assert(inline(e)[3].value.startsWith("**#17**"), inline(e)[3].value.slice(0, 20));
});

test("bands: the footer spacer is the last field, after every band", () => {
  const e = api.buildEmbed("marvel-rivals", roster(w.config, "marvel-rivals", 20), ctx);
  const last = e.fields[e.fields.length - 1];
  eq([last.inline, last.name, last.value], [false, ZW, ZW]);
});

test("render: an empty board says so and has no fields", () => {
  const e = api.buildEmbed("marvel-rivals", [], ctx);
  assert(/No players tracked yet/.test(e.description));
  assert(!e.fields || e.fields.length === 0);
});

// ---- the two views ----

test("views: the home board mentions members and shows no tags", () => {
  const e = api.buildEmbed("marvel-rivals", roster(w.config, "marvel-rivals", 5), ctx);
  const col = inline(e)[0].value;
  assert(/<@200000000000000000>/.test(col), "mention present");
  assert(!/\[[A-Z0-9]{1,5}\]/.test(col), "no tag on the home board");
});

test("views: the global board never mentions anyone and tags every row", () => {
  const players = roster(w.config, "marvel-rivals", 8, (i) => (i % 2 ? { tag: "RMR" } : {}));
  const e = api.buildEmbed("marvel-rivals", players, ctx, GLOBAL);
  assert(!/<@!?\d+>/.test(JSON.stringify(e)), "a mention leaked into the global board");
  const lines = inline(e)[0].value.split("\n");
  assert(lines.every((l) => /\[(RMR|BLDRO)\] \*\*/.test(l)), lines.join(" | "));
  assert(lines.some((l) => l.includes("[RMR]")) && lines.some((l) => l.includes(`[${api.CONFIG.homeTag}]`)));
});

test("views: long names are cut to nameMax, without breaking an emoji in half", () => {
  const players = roster(w.config, "marvel-rivals", 2, (i) => ({ name: i ? "\u{1F320}".repeat(20) : "AVeryLongPlayerNameHere" }));
  const e = api.buildEmbed("marvel-rivals", players, ctx, GLOBAL);
  const text = inline(e)[0].value;
  assert(text.includes("AVeryLongPl…"), text);
  encodeURIComponent(text); // throws on a lone surrogate
  for (const line of text.split("\n")) {
    const name = line.slice(line.indexOf("] **") + 4, line.lastIndexOf("**"));
    assert(Array.from(name).length <= 12, `"${name}" is longer than nameMax`);
  }
});

test("views: icon role style shows the role emoji alone; unknown roles fall back to text", () => {
  const players = roster(w.config, "marvel-rivals", 2, (i) => ({ role: i ? "Sniper" : "Strategist" }));
  const col = inline(api.buildEmbed("marvel-rivals", players, ctx, GLOBAL))[2].value.split("\n");
  const strat = col.find((l) => l.includes(":strategist:"));
  assert(strat && !strat.includes("Strategist"), "role text should be gone: " + strat);
  assert(col.some((l) => l.includes("Sniper")), "a role without an emoji keeps its text");
});

test("views: title and footer overrides apply only to the view that asks for them", () => {
  const players = roster(w.config, "marvel-rivals", 3);
  const g = api.buildEmbed("marvel-rivals", players, ctx, GLOBAL);
  const h = api.buildEmbed("marvel-rivals", players, ctx);
  assert(g.description.startsWith("# Ladder RO - {game}"), g.description);
  eq(g.footer.text, "Global footer");
  assert(h.footer.text !== "Global footer" && !h.description.includes("Ladder RO"), "home board untouched");
});

test("render: markdown in a player name can't break the layout", () => {
  const e = api.buildEmbed("marvel-rivals", [{ id: "demo", name: "a*b_c`d", rank: "Gold 1", peak: "Gold 1", role: "-", updatedAt: "2026-10-01T12:00:00Z" }], ctx);
  assert(inline(e)[0].value.includes("a\\*b\\_c\\`d"), inline(e)[0].value);
});

// ---- regression against the v1.0 renderer ----

const fx = ENV.fixtures && ENV.fixtures.v10;
test("regression: the home board is byte-identical to v1.0 for up to 16 players", () => {
  assert(fx && fx.cases, "fixture tests/fixtures/v1.0-boards.json is missing");
  const old = world({ configText: fx.config });
  const oldApi = old.load();
  const octx = { emojiMap: emojiMap(old.discord) };
  for (const key of Object.keys(fx.cases)) {
    const [game, n] = key.split("/");
    const players = roster(old.config, game, Number(n));
    if (Number(n) >= 3) players[1] = Object.assign({}, players[1], { id: "demo-x", name: "Demo*Name_1" });
    eq(noTimestamp(oldApi.buildEmbed(game, players, octx)), fx.cases[key], `board ${key}`);
  }
});

// ---- sorting ----

test("sorting: rank first, then peak, then the most recent update", () => {
  const mk = (id, rank, peak, day) => ({ id, name: id, rank, peak, role: "-", updatedAt: `2026-10-${day}T12:00:00Z` });
  const list = [
    mk("low", "Gold 1", "Gold 1", "05"),
    mk("tieOld", "Diamond 1", "Diamond 1", "01"),
    mk("tieNew", "Diamond 1", "Diamond 1", "09"),
    mk("peak", "Diamond 1", "Grandmaster 1", "01"),
    mk("top", "Eternity", "Eternity", "01"),
  ];
  eq(list.sort(api.compareEntries("marvel-rivals")).map((p) => p.id), ["top", "peak", "tieNew", "tieOld", "low"]);
});

test("sorting: the order doesn't depend on the order of the input", () => {
  const players = roster(w.config, "marvel-rivals", 30);
  const a = [...players].sort(api.compareEntries("marvel-rivals")).map((p) => p.id);
  const b = [...players].reverse().sort(api.compareEntries("marvel-rivals")).map((p) => p.id);
  eq(a, b);
});

// ---- the invisible characters the layout stands on ----

test("invisible: FIG is exactly one figure space and ZWSP one zero-width space", () => {
  eq([api.FIG.length, api.FIG.charCodeAt(0)], [1, 0x2007], "FIG");
  eq([api.ZWSP.length, api.ZWSP.charCodeAt(0)], [1, 0x200b], "ZWSP");
  eq([api.THIN.charCodeAt(0), api.HAIR.charCodeAt(0)], [0x2009, 0x200a]);
});

test("invisible: padSpaces produces the width it was asked for (the FIG bug of July)", () => {
  for (const em of [0.4, 1, 1.9, 2.9, 5.1, 7]) {
    const got = api.estWidth(api.padSpaces(em));
    assert(Math.abs(got - em) <= 0.12, `asked for ${em}em, got ${got}em`);
  }
  eq(api.estWidth(api.ZWSP), 0, "ZWSP must count as zero width");
});

test("invisible: the Role header starts with a ZWSP anchor so Discord can't trim its padding", () => {
  const e = api.buildEmbed("marvel-rivals", roster(w.config, "marvel-rivals", 2), ctx);
  eq(inline(e)[2].name.charCodeAt(0), 0x200b);
});

test("invisible: the source file itself still contains the literal characters", () => {
  const src = ENV.sources.update;
  assert(/const FIG = " ";/.test(src), "FIG literal in scripts/update.js");
  assert(src.includes('{ name: "​", value: "​", inline: false }'), "spacer field literal");
});
