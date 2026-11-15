// Rank parsing: every tier and division of every game, aliases, bad input.
const { test, assert, eq, rejects, world } = T;

const api = world().load();
const games = Object.keys(api.CONFIG.games);

for (const game of games) {
  const g = api.CONFIG.games[game];

  test(`ranks/${game}: every tier and division parses, and scores climb with the ladder`, () => {
    let previous = -Infinity;
    let checked = 0;
    for (const tier of g.tiers) {
      const divisionless = (g.divisionlessTiers || []).includes(tier);
      // worst division first, whatever direction the game counts in
      const divisions = divisionless
        ? [null]
        : Array.from({ length: g.divisionCount }, (_, i) => (g.divisionAscending ? i + 1 : g.divisionCount - i));
      for (const d of divisions) {
        const input = d === null ? tier : `${tier} ${d}`;
        const r = api.parseRank(game, input);
        eq(r.display, input, `display of "${input}"`);
        assert(r.score > previous, `"${input}" (score ${r.score}) should rank above the previous step (${previous})`);
        previous = r.score;
        checked++;
      }
    }
    assert(checked >= g.tiers.length, "ladder walked");
  });

  test(`ranks/${game}: every configured alias resolves to its tier`, () => {
    for (const [alias, tier] of Object.entries(g.tierAliases || {})) {
      // the way mods type it: alias plus a division (none for divisionless tiers)
      const input = (g.divisionlessTiers || []).includes(tier) ? alias : `${alias} 1`;
      const r = api.parseRank(game, input);
      assert(r.display.startsWith(tier), `"${input}" gave "${r.display}", wanted ${tier}`);
    }
  });

  test(`ranks/${game}: input is case-insensitive`, () => {
    const tier = g.tiers[0];
    eq(api.parseRank(game, tier.toUpperCase()).display, api.parseRank(game, tier.toLowerCase()).display);
  });

  test(`ranks/${game}: a division outside the game's range is rejected`, async () => {
    const tier = g.tiers.find((t) => !(g.divisionlessTiers || []).includes(t));
    await rejects(() => api.parseRank(game, `${tier} ${g.divisionCount + 4}`), /divisions/);
  });

  test(`ranks/${game}: nonsense is rejected with the list of valid tiers`, async () => {
    const e = await rejects(() => api.parseRank(game, "potato 2"), /Unknown/);
    assert(e.message.includes(g.tiers[0]), "error lists the valid tiers");
  });
}

test(
  "ranks: an alias typed WITHOUT a division is accepted too",
  () => {
    const broken = [];
    for (const game of games) {
      for (const [alias, tier] of Object.entries(api.CONFIG.games[game].tierAliases || {})) {
        try {
          assert(api.parseRank(game, alias).display.startsWith(tier));
        } catch (e) {
          broken.push(`${game}: "${alias}"`);
        }
      }
    }
    eq(broken, [], "aliases rejected when typed alone");
  }
);

test("ranks: Marvel Rivals shorthand the mods actually type", () => {
  const p = (s) => api.parseRank("marvel-rivals", s).display;
  eq(p("gm 2"), "Grandmaster 2");
  eq(p("gm1"), "Grandmaster 1");
  eq(p("GM3"), "Grandmaster 3");
  eq(p("cel 1"), "Celestial 1");
  eq(p("Cel 2"), "Celestial 2");
  eq(p("CEL3"), "Celestial 3");
  eq(p("celest 3"), "Celestial 3");
  eq(p("plat 3"), "Platinum 3");
  eq(p("dia 1"), "Diamond 1");
  eq(p("Diamond II"), "Diamond 2");
  eq(p("oaa"), "One Above All");
  eq(p("one above all"), "One Above All");
  eq(p("Eternity"), "Eternity");
});

test("ranks: a number after a divisionless tier is ignored, not an error", () => {
  eq(api.parseRank("marvel-rivals", "Eternity 5000").display, "Eternity");
});

test("ranks: unranked sorts below everything", () => {
  const r = api.parseRank("marvel-rivals", "unranked");
  eq(r.display, "Unranked");
  assert(r.score < api.parseRank("marvel-rivals", "Bronze 3").score);
});

test("ranks: division direction per game (OW 1 is best, Deadlock 6 is best)", () => {
  const s = (game, x) => api.parseRank(game, x).score;
  assert(s("overwatch", "Diamond 1") > s("overwatch", "Diamond 5"), "OW");
  assert(s("deadlock", "Oracle 6") > s("deadlock", "Oracle 1"), "Deadlock");
  assert(s("marvel-rivals", "Gold 1") > s("marvel-rivals", "Gold 3"), "Rivals");
});

test("ranks: the lowest step of a tier still beats the top of the tier below", () => {
  const s = (x) => api.parseRank("marvel-rivals", x).score;
  assert(s("Gold 3") > s("Silver 1"));
  assert(s("One Above All") > s("Eternity"));
});
