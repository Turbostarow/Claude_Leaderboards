# CLAUDE.md — Discord game leaderboards

Context for working on this repo (`Turbostarow/Claude_Leaderboards`, local `G:\Claude`).
Read alongside [README.md](README.md) (user-facing docs) — this file is the dev/agent brief.

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
  `#leaderboards-manager` `1528159080605155428`, log channel `1332314116051828868`.
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
- Markdown headings (`#`/`##`) render in embed descriptions and field values, NOT in
  titles/field names — that's how the big title and big column headers are done.
  A line starting with `#` in a description accidentally becomes a jumbo heading.
- Custom emojis resolve as `<:name:id>`; the script fetches `/guilds/{id}/emojis` each
  run and resolves `":name:"` strings from config (`tierEmoji`, `roleEmoji`, `title`
  tokens) by name, case-insensitive fallback, 🔹 or literal text when missing.
- Mentions in embeds don't ping (plus `allowed_mentions: {parse: []}` everywhere);
  entries whose `id` isn't numeric render as bold names instead of mentions (used for
  demo/seed players — a fake id would show as @unknown-user).
- Proportional font means figure-space padding aligns only approximately; don't promise
  pixel columns. On mobile the 3 columns stack vertically (platform behavior).

## Current state & conventions

- Render style: `"table"` (default; `"rows"` and `"ansi"` still exist behind
  `config.renderStyle`). Sorting: current rank desc → peak desc → earliest `updatedAt`
  wins ties. Rank ladders/divisions per game in config (`divisionAscending`: OW/MR
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

## Verify loop after any change

1. Push (triggers a run via the push path filter; `FORCE_RENDER` is true for non-cron).
2. Browser tab on example.com: fetch the raw file at the new SHA → `new Function`
   compile check → dry-run the changed renderer with real config/data + a fake emoji
   map → poll the Actions API until the run for that SHA completes green.
3. Ask the user to eyeball the channel — Discord's renderer is the final judge.
