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
- The board renders as a 3-column grid (`"renderStyle": "table"`, the default): bold column headers `# · Player | Current Rank · Peak | Role … Updated`, one aligned row per player with a custom rank emoji, a role emoji (per-game `roleEmoji` map, matched case-insensitively against the role text), a real @mention (entries with non-numeric ids render as bold plain names instead), and a live relative timestamp — the Role/Updated column is aligned with figure-space padding, plus an empty spacer row before the footer. On mobile, Discord stacks the three columns vertically (platform behaviour, not configurable). Rank emoji entries in `tierEmoji` that look like `":grandmaster:"` are resolved to the server's custom emojis at runtime (fallback 🔹 if missing); plain unicode emoji are used as-is. Sorting: current rank → peak rank → most recent last-update (on a perfect tie the newcomer overtakes). Boards cap at `maxPlayers` (16): a qualifying `!add` bumps the bottom player off the board (noted in the log channel); an applicant who wouldn't make the cut is rejected with a clear reason. Other styles: `"rows"` = one markdown line per player; `"ansi"` = colored monospace code-block table (aligned columns, but no custom emoji, mentions or live timestamps — Discord limitation).
- Every roster change is a commit in [`data/`](data/), so there's a full audit trail.
- Every processed command is **deleted from the mod channel** (keeping it clean) and mirrored to the log channel as `✅/❌ @mod used: <command>` plus the outcome. Failed commands ping their author there so mistakes don't vanish silently. Systemic failures (bad token, missing permissions) go to the log channel too, falling back to the mod channel.
- If the bot can't delete (missing *Manage Messages*) or can't reach the log channel, it falls back to the old behaviour: ✅ / ❌ reactions and in-place replies.

## Mod commands (private channel)

```
!add <game> @player rank: <rank> [peak: <rank>] [role: <text>] [name: <text>]
!update <game> @player [rank: ...] [peak: ...] [role: ...] [name: ...]
!remove <game> @player
!refresh        force re-render of all leaderboards
!help           show help in Discord
```

- Games: `rivals` / `ow` / `deadlock` (aliases: `mr`, `marvel`, `ow2`, `dl`, …)
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
