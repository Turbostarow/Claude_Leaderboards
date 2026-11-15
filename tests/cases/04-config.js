// config.json is edited by hand on GitHub - these catch the mistakes that
// would otherwise only show up as a broken board.
const { test, assert, eq, world, ENV } = T;

const api = world().load();
const cfg = JSON.parse(ENV.sources.config);
const isId = (v) => /^\d{15,20}$/.test(String(v));

test("config: channel ids look like Discord ids", () => {
  assert(isId(cfg.modChannelId), "modChannelId");
  assert(isId(cfg.logChannelId), "logChannelId");
  for (const [k, g] of Object.entries(cfg.games)) {
    assert(!g.channelId || isId(g.channelId), `${k}.channelId`);
  }
});

test("config: no two games share a channel", () => {
  const ids = Object.values(cfg.games).map((g) => g.channelId).filter(Boolean);
  eq(new Set(ids).size, ids.length);
});

for (const [key, g] of Object.entries(cfg.games)) {
  test(`config/${key}: tier lists line up`, () => {
    assert(Array.isArray(g.tiers) && g.tiers.length > 0, "tiers");
    if (g.tierShort) eq(g.tierShort.length, g.tiers.length, "tierShort has one entry per tier");
    if (g.tierEmoji) eq(g.tierEmoji.length, g.tiers.length, "tierEmoji has one entry per tier");
    eq(new Set(g.tiers.map((t) => t.toLowerCase())).size, g.tiers.length, "no duplicate tiers");
  });

  test(`config/${key}: aliases and divisionless tiers point at real tiers`, () => {
    for (const [alias, tier] of Object.entries(g.tierAliases || {})) {
      assert(g.tiers.includes(tier), `alias "${alias}" -> "${tier}" is not a tier`);
    }
    for (const t of g.divisionlessTiers || []) assert(g.tiers.includes(t), `divisionless "${t}" is not a tier`);
  });

  test(`config/${key}: an alias never shadows a different tier's name`, () => {
    const names = g.tiers.map((t) => t.toLowerCase());
    for (const [alias, tier] of Object.entries(g.tierAliases || {})) {
      const i = names.indexOf(alias.toLowerCase());
      assert(i === -1 || g.tiers[i] === tier, `alias "${alias}" is also the tier ${g.tiers[i]}`);
    }
  });

  test(`config/${key}: divisions, colour and labels are usable`, () => {
    assert(Number.isInteger(g.divisionCount) && g.divisionCount >= 1 && g.divisionCount <= 6, "divisionCount 1-6");
    assert(/^#[0-9a-f]{6}$/i.test(g.color), "color is #rrggbb");
    assert(g.label && g.roleLabel, "label and roleLabel");
    assert(["numeric", "roman"].includes(g.divisionStyle), "divisionStyle");
  });

  test(`config/${key}: game aliases resolve to the game`, () => {
    for (const a of [key].concat(g.aliases || [])) eq(api.resolveGame(a), key, `alias "${a}"`);
  });
}

test("config: a game alias never points at two games", () => {
  const seen = {};
  for (const [key, g] of Object.entries(cfg.games)) {
    for (const a of g.aliases || []) {
      assert(!seen[a.toLowerCase()], `alias "${a}" is used by ${seen[a.toLowerCase()]} and ${key}`);
      seen[a.toLowerCase()] = key;
    }
  }
});

test("config: home tag, caps and mirror settings are valid", () => {
  assert(/^[A-Z0-9]{1,5}$/.test(cfg.homeTag), "homeTag is 1-5 letters/digits, upper-case");
  assert(Number.isInteger(cfg.maxPlayers) && cfg.maxPlayers >= 0, "maxPlayers");
  const m = cfg.mirror || {};
  assert(Array.isArray(m.admins) && m.admins.every(isId), "mirror.admins is a list of user ids");
  assert(Number.isInteger(m.maxPlayers) && m.maxPlayers > 0, "mirror.maxPlayers");
  assert(Number.isInteger(m.nameMax) && m.nameMax >= 3, "mirror.nameMax");
  assert(["icon", "text"].includes(m.roleStyle), "mirror.roleStyle");
  assert(!m.title || m.title.length <= 200, "mirror.title length");
});

test("config: renderStyle is one the script knows", () => {
  assert(["table", "rows", "ansi"].includes(cfg.renderStyle || "table"));
});
