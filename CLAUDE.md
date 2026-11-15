# CLAUDE.md — Discord game leaderboards

Context for working on this repo (`Turbostarow/Claude_Leaderboards`, local `G:\Claude`).
Read alongside [README.md](README.md) (user-facing docs) — this file is the dev/agent brief.
How to work *with the user* (language, when to ask, what needs permission) lives machine-wide
in `~/.claude/CLAUDE.md` — keep that out of this file, which is public.

## What this is

Self-updating Discord leaderboards for Marvel Rivals / Overwatch 2 / Deadlock in the
"Blood Rose | RO Esports" server (guild `1315441635504553994`). Zero-dependency Node
script (`scripts/update.js`, Node 18+, Discord REST v10 only, no libraries) driven
entirely by GitHub Actions (`.github/workflows/leaderboards.yml`): cron every 20 min +
`workflow_dispatch` + push-to-main on data/config/scripts changes. No server, no hosting.

- Bot: **Ice Idol** (app id `953340420149108837`), hosted by SCNX.app for other modules.
  This repo only uses its token via REST from Actions — that coexists fine with SCNX's
  gateway connection. **Never set an Interactions Endpoint URL on the app** (would break
  SCNX slash commands). Token lives ONLY in the repo Actions secret `DISCORD_TOKEN`,
  never in any file.
- Channels (config.json): marvel-rivals `1528158779793998006`, overwatch
  `1528158810307301446`, deadlock `1528158837218214140`, mod channel
  `#leaderboards-manager` `1528159080605155428`, log channel `1332314941293723732`.
- Mods post `!add/!update/!remove/!refresh/!help` in the mod channel; each run polls new
  messages, applies them, mirrors `@mod used: <command>` + outcome to the log channel,
  deletes the command message (falls back to ✅/❌ reactions if Manage Messages or log
  access is missing), commits `data/*.json`, and edits one embed per game channel in
  place (message ids in `data/state.json`).

## Hard-won environment facts

- **This machine cannot reach most of the Discord API**: guild/channel endpoints return
  403 `{"code": 40333, "message": "internal network error"}` — an IP-level partial block
  by Discord's edge (`/users/@me` works, everything guild-scoped doesn't). Do NOT
  diagnose permission problems from local API calls. Verify through Actions runs
  instead: public API `https://api.github.com/repos/Turbostarow/Claude_Leaderboards/actions/runs`
  (works from the in-app browser on an `https://example.com` tab; github.com pages have
  CSP that blocks eval, raw.githubusercontent blocks fetch).
- **No Node, no gh CLI on this machine.** Syntax-check by fetching the pushed file at a
  commit SHA from raw.githubusercontent and compiling with `new Function(src)` in the
  browser tab (strip the `#!` shebang line first). Dry-run renderers by slicing function
  segments out of the source and evaluating them with the real config/data.
- **Local tests without Node: headless Edge.** `msedge.exe` exists at
  `C:\Program Files (x86)\Microsoft\Edge\Application`. Build one HTML file with
  PowerShell that embeds the sources as JSON (`ConvertTo-Json`; get old versions
  byte-exact with `cmd /c "git show <ref>:<path> > file"`), load `update.js` inside
  `new Function("require","process","__dirname","console","fetch", src + ";return {...}")`
  with stubbed `fs`/`path`/`fetch` (a never-resolving fetch parks `main()`), then run
  `msedge --headless=new --user-data-dir=<scratch> --virtual-time-budget=15000 --dump-dom
  file:///...` and read the result out of the dumped DOM. This runs the real renderer
  and `executeLine` before anything is pushed - prefer it over push-then-check.
- **PowerShell 5.1 quoting mangles embedded double quotes to native commands** — write
  multi-line commit messages to a scratchpad file and use `git commit -F <file>`.
- The Actions bot pushes data commits (`[skip ci]`) — always `git pull --rebase` before
  pushing; the workflow itself pulls/rebases before its own push and has a concurrency
  group plus a keepalive commit (GitHub disables idle crons after 60 days).
- **Invisible characters are load-bearing** in `scripts/update.js` and must survive
  edits: `FIG` = U+2007 figure space (non-collapsing padding), zero-width spaces U+200B
  as embed field names/spacer values (Discord rejects empty), U+200B in the log
  backtick-sanitizer. When editing near them, verify bytes afterward via PowerShell
  char-code dumps. Model output tends to convert `\uXXXX` escapes into literal chars —
  writing them via PowerShell `.Replace()` with `[char]27` style construction avoids that.

## Discord rendering constraints (learned the hard way)

- Colored text exists ONLY in ```ansi code blocks; code blocks can't render custom
  emojis, @mentions, or `<t:...>` timestamps. You can't have both — the user chose the
  live grid.
- Inline embed fields cap at **3 per row** (6 fields fold into two bands of 3).
- Markdown headings (`#`/`##`) render ONLY in embed descriptions — not in titles, field
  names, or field values (verified live: `##` in a field value shows literal hashes).
  The big board title is a `#` heading in the description; column headers are stuck at
  Discord's fixed bold field-name size. A line starting with `#` in a description
  accidentally becomes a jumbo heading.
- Custom emojis resolve as `<:name:id>`; the script fetches `/guilds/{id}/emojis` each
  run and resolves `":name:"` strings from config (`tierEmoji`, `roleEmoji`, `title`
  tokens) by name, case-insensitive fallback, 🔹 or literal text when missing.
- Mentions in embeds don't ping (plus `allowed_mentions: {parse: []}` everywhere);
  entries whose `id` isn't numeric render as bold names instead of mentions (used for
  demo/seed players — a fake id would show as @unknown-user).
- Proportional font means figure-space padding aligns only approximately; don't promise
  pixel columns. On mobile the 3 columns stack vertically (platform behavior).
- **Discord trims leading whitespace from field names/values** — a header built as
  `padSpaces(...) + "Role" + ... + "Updated"` loses its leading pad, so the nudge appears
  to move the *wrong* label (the trailing one). Fix: start the string with a U+200B
  anchor. `estWidth` must count ZWSP as 0 or the pad math drifts by half an em.
- `padSpaces` derives its increments from `estWidth` (never hardcode per-char widths in
  both places): a stray edit once made `FIG` two characters, so estWidth said 0.85em
  while padSpaces assumed 0.55em, and the error leaked into the Updated column.

## v1.2: community tags + global boards via webhook (`mirror/`)

- Git: tag `v1.0` = last single-server version. v1.2 adds the optional `mirror/` module;
  `scripts/update.js` loads it in a try/catch (`MODULE_NOT_FOUND` -> `mirror = null`) and
  everything else must keep working with the folder deleted.
- One roster per game, two views. Players carry an optional `tag` (1-5 chars A-Z0-9);
  no `tag` field = home community (`config.homeTag`, BLDRO) - existing data files were
  not migrated. Home board (bot message) = `filter(isHome)`, mentions, identical to v1.0
  for <=16 players. Global board (mirror) = everyone, `[TAG] **Name**`, top
  `mirror.maxPlayers`, never mentions (users outside a server render as unknown ids).
- Renderer: `buildTableEmbed(..., view)`; rows go in bands of `BAND_SIZE` 16, each band =
  3 inline fields in the SAME embed (later bands use ZWSP field names -> one blank line
  after #16; that seam cannot be shrunk). `view` = `{ names: "tagged", nameMax,
  roleStyle: "icon", title, footer }`, honoured by the table style only.
- Discord limits (read in the official docs 2026-11): field value 1024, field name 256,
  description 4096, 25 fields, **6000 chars total per message across all embeds**. The
  Role column costs ~61 chars/row (custom emoji tag ~33 + role + pad + 16-char
  timestamp), which is why a band is 16 rows; ~40 rows fit one embed in total.
- Webhooks (docs): `POST /webhooks/{id}/{token}?wait=true` returns the message;
  `PATCH .../messages/{id}` edits it. `username`/`avatar_url` exist ONLY on POST, so
  changing them means delete + re-post. Non-app-owned webhooks cannot send interactive
  components (no SCNX buttons on partner boards).
- Webhook URLs are credentials and the repo is public: stored only as AES-256-GCM
  blobs in `mirror/targets.json` (key = sha256 of the `MIRROR_KEY` secret, one key for
  all partners). `redactWebhooks` in update.js and `redact` in the module keep URLs out
  of the log channel, replies and the public Actions log - never log a URL or an
  unredacted error. Dead webhook (404 code 10015 / 401 code 50027) -> target auto-hidden.
- `mirror/state.json` holds message id + content hash per partner/game; a board is
  PATCHed only when the hash changes (dispatch runs set FORCE_RENDER every 15 min, so
  the mirror deliberately ignores it; only `!refresh` forces a resend).
- Unverified until the first live test: custom server emojis on other servers, the
  width of `[TAG] Name` (estimated ~12 name chars with `roleStyle: "icon"`, ~4-5 with
  role text), and the crypto + webhook HTTP paths (not runnable locally).
- Backburner (user's call): per-partner rosters, partner self-service intake, numeric
  ratings (CS2 Premier), unicode emoji fallback for partner boards.

## Current state & conventions

- Render style: `"table"` (default; `"rows"` and `"ansi"` still exist behind
  `config.renderStyle`). Sorting: current rank desc → peak desc → most RECENT
  `updatedAt` wins ties (user's choice: newcomers overtake on perfect ties).
  `config.maxPlayers` (32) caps each COMMUNITY (tag): a qualifying `!add` evicts the
  bottom player of the same community (noted in the reply/log), non-qualifying adds
  throw a clear rejection; other communities are never touched. Rank ladders/divisions per game in config (`divisionAscending`: OW/MR
  false = div 1 best, Deadlock true = 6 best; MR `divisionStyle` numeric by user
  choice; `divisionlessTiers` = Eternity, One Above All → short "OAA").
- MR has server emojis for tiers (`:bronze:`…`:oneaboveall:`) and roles
  (`:strategist: :duelist: :vanguard: :flex:`) plus `:MR:` (game logo, used in the
  title). OW/Deadlock still use unicode placeholder tier emojis — swap to `":name:"`
  entries when the user uploads them.
- `data/marvel-rivals.json` currently holds ZackFair (real member,
  id `135516278721871872`) plus five `demo-*` seed players the user asked for while
  iterating on the format — **to be removed when the user says they're satisfied**
  (keep ZackFair unless told otherwise).
- The user wants **visual previews in chat BEFORE code changes** for formatting work
  (approximate Discord look in an HTML widget; real emoji art can't be loaded there —
  say so). Implement only after approval.
- Commit style: imperative summary line; body only when it earns its place; trailer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` on multi-line messages.
- Pending user-side items: rotate the bot token (it leaked into a chat once) —
  Dev Portal reset → update SCNX dashboard + `DISCORD_TOKEN` secret; upload OW/DL
  rank emojis; possibly wipe the roster each new season (footer promises it).

## Tests (`tests/`)

- `tests/lib/harness.js` = runner + loader + fake Discord (enforces the real embed
  limits, supports failure injection via `discord.fail(match, responses)`); evaluated
  with `new Function("ENV", src)`, so the same case files run under Node
  (`node tests/run.js`, the *Tests* workflow) and in headless Edge
  (`powershell -ExecutionPolicy Bypass -File tests\run-local.ps1`, no Node needed).
  `world()` gives a sandbox: `.modSay()`, `.run()` (= one workflow run), `.board()`,
  `.logText()`, `.files`, `.discord`.
- **Run `tests\run-local.ps1` before proposing any push.** Locally the cipher is a
  stand-in (Edge has no Node crypto); the two real-AES tests are `nodeOnly`.
- `update.js` exports its functions and only calls `main()` under
  `require.main === module` - that is what lets the suite load it.
- `tests/fixtures/v1.0-boards.json` = boards rendered by the v1.0 code with the v1.0
  config (regenerate only by running the tagged v1.0 source through the harness).
- `knownBug` tests document defects the user has not decided on; they don't fail the
  suite, and the runner complains once they pass. Open ones (2026-11): bare aliases
  ending in i/v (`slv`, `emi`) are rejected by `parseRank`; `mirror/state.json` can
  store an unredacted error string.
- `tests/live.js` + the *Live test* workflow hit a real test webhook
  (`TEST_WEBHOOK_URL` secret), with their own in-memory files and throwaway key.

## Verify loop after any change

1. **Ask the user before pushing** — a push rewrites the live embeds in his community
   server, so it is never automatic (see `~/.claude/CLAUDE.md`). Once approved, push
   (triggers a run via the push path filter; `FORCE_RENDER` is true for non-cron).
2. Browser tab on example.com: fetch the raw file at the new SHA → `new Function`
   compile check → dry-run the changed renderer with real config/data + a fake emoji
   map → poll the Actions API until the run for that SHA completes green.
3. Ask the user to eyeball the channel — Discord's renderer is the final judge.
