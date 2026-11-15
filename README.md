# Claude_Leaderboards

Self-updating Discord leaderboards for **Marvel Rivals**, **Overwatch 2** and **Deadlock**, run entirely by GitHub Actions — no server, no hosting costs.

## How it works

```
mods post !commands in a private channel
        │
        ▼   every ~20 min (or on demand)
GitHub Actions ──► reads new mod messages ──► updates data/*.json (committed here)
        │
        ▼
edits one pinned-style bot message per game channel with the sorted leaderboard
```

- Each game has one bot message in its own channel that gets **edited in place** — channels never fill up with reposts.
- The board renders as a 3-column grid (`"renderStyle": "table"`, the default): bold column headers `# · Player | Current Rank · Peak | Role … Updated`, one aligned row per player with a custom rank emoji, a role emoji (per-game `roleEmoji` map, matched case-insensitively against the role text), a real @mention (entries with non-numeric ids render as bold plain names instead), and a live relative timestamp — the Role/Updated column is aligned with figure-space padding, plus an empty spacer row before the footer. On mobile, Discord stacks the three columns vertically (platform behaviour, not configurable). Rank emoji entries in `tierEmoji` that look like `":grandmaster:"` are resolved to the server's custom emojis at runtime (fallback 🔹 if missing); plain unicode emoji are used as-is. Sorting: current rank → peak rank → most recent last-update (on a perfect tie the newcomer overtakes). Boards cap at `maxPlayers` (32) **per community**: a qualifying `!add` bumps the bottom player of the same community off the board (noted in the log channel); an applicant who wouldn't make the cut is rejected with a clear reason. Up to 16 players the board is one block; past that the rows continue in a second band inside the same embed (Discord limits a field to 1024 characters, so there is one blank line after #16). Other styles: `"rows"` = one markdown line per player; `"ansi"` = colored monospace code-block table (aligned columns, but no custom emoji, mentions or live timestamps — Discord limitation).
- Every roster change is a commit in [`data/`](data/), so there's a full audit trail.
- Every processed command is **deleted from the mod channel** (keeping it clean) and mirrored to the log channel as `✅/❌ @mod used: <command>` plus the outcome. Failed commands ping their author there so mistakes don't vanish silently. Systemic failures (bad token, missing permissions) go to the log channel too, falling back to the mod channel.
- If the bot can't delete (missing *Manage Messages*) or can't reach the log channel, it falls back to the old behaviour: ✅ / ❌ reactions and in-place replies.

## Mod commands (private channel)

```
!add <game> @player rank: <rank> [peak: <rank>] [role: <text>] [name: <text>] [tag: <community>]
!update <game> @player [rank: ...] [peak: ...] [role: ...] [name: ...] [tag: ...]
!remove <game> @player
!refresh        force re-render of all leaderboards
!help           show help in Discord
```

- Games: `rivals` / `ow` / `deadlock` (aliases: `mr`, `marvel`, `ow2`, `dl`, …)
- `tag:` (1–5 letters/digits) marks a player from another community. Without it the player belongs to the home community (`homeTag` in `config.json`). Our own boards show home players only; tagged players appear on the global boards (see below).
- `hero:` is an alias for `role:` (use it for Deadlock).
- `peak:` defaults to the current rank; peak is auto-raised if rank ever exceeds it.
- `name:` defaults to the player's server display name.
- Multiple commands in one message are fine — one per line.
- Commands are picked up on the next scheduled run (~20 min). For instant processing: **Actions → Leaderboards → Run workflow**.

Examples:

```
!add rivals @Luna rank: Diamond 2 peak: GM 3 role: Duelist
!update ow @Luna rank: Master 4
!add deadlock @Luna rank: Oracle 4 hero: Haze
!remove rivals @Luna
```

Rank input is forgiving: `Diamond 2`, `diamond II`, `plat 3`, `gm1`, `GOLD III` all work. Valid tiers per game live in [`config.json`](config.json), including division direction (OW div 1 > div 5, Deadlock subrank 6 > 1, Rivals I > III).

## Global boards on other servers (optional `mirror/` module)

One roster per game, two views:

- **Home board** — the bot's own message in our channels: home-community players only, with @mentions. Unchanged from v1.0.
- **Global board** — every community, rows shown as `[TAG] Name`, neutral title, no buttons. It is sent through a **webhook**, so the bot never has to join the other server. Our own server can show it too: create a webhook in the channel and add it like any partner.

The partner creates a webhook (*Channel Settings → Integrations → Webhooks*) and hands over its URL. In the mod channel:

```
!mirror add <webhook-url> name: <partner> games: <games|all> [title: ...] [footer: ...] [botname: ...] [avatar: <url>]
!mirror edit <partner> [games: ...] [title: ...] [footer: ...] [botname: ...] [avatar: ...]
!mirror hide <partner>      !mirror show <partner>
!mirror remove <partner>    !mirror list
```

- `title:` may contain `{game}`; `default` clears an optional setting. Defaults live under `mirror` in [`config.json`](config.json) (`title`, `footer`, `maxPlayers`, `nameMax`, `roleStyle`, `admins`).
- By default the board shows the name and avatar the partner gave the webhook. `botname:` / `avatar:` override them; Discord fixes both when a message is sent, so changing them deletes and re-posts the board.
- A board is only edited when its content actually changed. If the partner deletes the message it is posted again; if they delete the webhook the partner is switched off and the log channel says so.
- `mirror.admins` empty = any mod may run `!mirror`; list user ids there to restrict it.
- Needs the `"table"` render style. `nameMax` trims long names and `roleStyle: "icon"` shows the role emoji without text — both exist because a 5-character tag has to fit in the fixed embed width.

**Secrets.** A webhook URL lets anyone post in that channel and this repository is public, so URLs are stored only encrypted (AES-256-GCM) in `mirror/targets.json`. The key is one repository secret, `MIRROR_KEY`, set once for all partners; if it is changed or lost, partners have to be added again. The command message is deleted after processing and the URL is redacted from the log channel, but until that run it is visible to whoever can read the mod channel.

Removing the `mirror/` folder turns all of this off; the home boards keep working exactly as before.

## Tests

The suite in [`tests/`](tests/) runs the real `scripts/update.js` and `mirror/index.js` against an in-memory **fake Discord** and in-memory files — it never touches the live server, `data/` or `mirror/`.

- **On GitHub:** the *Tests* workflow runs it on every push that touches code, config or tests (`node tests/run.js`). It only reports; a red run never stops the leaderboards.
- **On this machine (no Node needed):**

  ```
  powershell -ExecutionPolicy Bypass -File tests\run-local.ps1
  ```

  Same tests in headless Edge. Edge has no Node crypto, so encryption uses a stand-in there and the tests that check real AES run only on GitHub.
- **Live test:** the *Live test* workflow (started by hand) posts, edits, renames, hides and deletes a real board on a test webhook. It needs the secret `TEST_WEBHOOK_URL`. With *keep* ticked it leaves a 32-row board with long names and 5-character tags to look at.

What it covers: rank parsing for every tier of every game, all commands, tags and the per-community cap, Discord's embed limits over many roster sizes, the home/global views, a byte-for-byte comparison with the v1.0 board, the invisible layout characters, `config.json` sanity, full runs with Discord failing (503, 429, deleted messages, dead token, network errors), the whole partner lifecycle, and a search for leaked webhook URLs. A test marked `knownBug` documents a real defect nobody has decided to fix yet; it is listed but does not fail the suite.

What no test can tell you: how a board *looks* in Discord (width, alignment) — that is what the live test's kept board is for.

## Setup checklist

1. **Bot**: any Discord bot token works (this repo uses an existing bot). The bot must be in the server with, per channel:
   - the 3 leaderboard channels: *View Channel, Send Messages, Embed Links*
   - the private mod channel: *View Channel, Read Message History, Send Messages, Add Reactions, Manage Messages* (the last one is what allows deleting processed commands)
   - the log channel: *View Channel, Send Messages*
2. **Secret**: repo → *Settings → Secrets and variables → Actions → New repository secret* → name `DISCORD_TOKEN`, value = the bot token. **The token never goes in any file.**
3. **Channels**: IDs live in [`config.json`](config.json) (`modChannelId`, `logChannelId` + one `channelId` per game).
4. Push / run the workflow once — the bot posts an initial empty leaderboard in each channel and starts watching the mod channel from that moment (older messages are ignored).

## Notes & gotchas

- **Scheduling is best-effort**: GitHub cron sometimes runs a few minutes late. The `workflow_dispatch` button is the reliable "now" path.
- **60-day rule**: GitHub disables cron on inactive repos; the workflow auto-commits a keepalive before that happens.
- **Anyone who can type in the mod channel can edit the leaderboards** — the channel's Discord permissions are the access control.
- Hand-editing `data/*.json` or `config.json` on GitHub also works; pushing to `main` triggers a re-render.
- **If the bot token is ever reset** (e.g. in the Discord Developer Portal), update the `DISCORD_TOKEN` secret here *and* wherever else the bot runs (SCNX).
- `data/state.json` remembers which bot message is the leaderboard in each channel and the last processed mod message. Deleting a leaderboard message is safe — the next run just posts a fresh one.
