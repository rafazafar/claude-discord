# Claude for Discord

A Claude Tag–style teammate for Discord, built on the [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview). Tag `@Claude` in a channel, it opens a thread, works through the task with the tools its channel allows, and posts the result. Replies in the thread continue the same session without re-tagging.

## What it does

| Claude Tag feature | Here |
|---|---|
| Tag `@Claude` to hand off work, reply in thread | Mention → thread → live progress with a **Stop** button → result. Follow-ups in the thread resume the session. Messages sent mid-run are batched into the next turn. |
| Access bundles per channel | `config/bundles.json` defines bundles (web, code, GitHub, MCP servers, role limits, step/budget caps). Admins attach one per channel with `/claude enable`. |
| Channel memory | "From now on…" instructions are saved per channel or server and fed into every session. Manage with `/claude memory`. |
| Ambient behaviour | `/claude reply mode:ambient` lets Claude jump in when a small model judges it can clearly help. Rate-limited per channel. |
| Standing scheduled work | "Every weekday at 9am, summarise yesterday" → a cron schedule that posts a fresh thread each run (text and announcement channels; not forums). |
| Quieting | "Stop replying here" → quiet thread; `/claude reply mode:mention` → mention-only. |
| DMs | Optional (off by default), on their own bundle. |
| Switchable credential | API key or Claude plan sign-in; flip live with `/claude auth`. |

## 1. Create the Discord app

1. <https://discord.com/developers/applications> → **New Application**. Copy the **Application ID** → `DISCORD_APP_ID`.
2. **Bot** tab → **Reset Token** → `DISCORD_TOKEN`. Turn on **Message Content Intent**.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Attach Files, Add Reactions, Embed Links. Open the URL to invite the bot.

## 2. Choose a Claude credential

Set one or both in the environment:

- **`ANTHROPIC_API_KEY`** (default). Pay-as-you-go, **or your Max/Team plan's monthly API credits**: claim them in claude.ai billing settings into a linked Claude Console org, then create the key in that org. Requests stop when credits run out unless the org has purchased credits or auto-reload.
- **`CLAUDE_CODE_OAUTH_TOKEN`**. Run `claude setup-token` and paste the token. Uses your plan's own usage limits, not the monthly credits. It's tied to one person's account, so check Anthropic's terms before running a shared server on it.

With both set, admins switch at any time with `/claude auth` (persists across restarts; `default` returns to `AUTH_MODE`). The agent only ever receives one credential, so it's always clear which pool pays.

## 3. Configure access bundles

Edit `config/bundles.json`. Capabilities:

- `web`: WebSearch, WebFetch
- `code`: shell and file tools in a per-thread working directory
- `github`: `code` plus `git`/`gh` authenticated with the token in `github.tokenEnv`. Use a **fine-grained PAT scoped to the listed repos**: that's the real enforcement.
- `mcpServers`: any stdio/http/sse MCP servers; `${VAR}` is replaced from the environment.

Also per bundle: `allowedRoleIds`, `model`, `maxTurns`, `maxBudgetUsd`, `instructions`. The file is re-read automatically when it changes.

## 4. Deploy on Dokploy

1. Push this folder to a Git repo.
2. Dokploy → **Create Service → Compose** → point it at the repo (compose file `docker-compose.yml`).
3. **Environment**: paste your values from `.env.example`.
4. Deploy. Logs should show `agent isolation {"runAs":"agent"}` and `connected to Discord`. Global slash commands can take a few minutes to appear; set `DEV_GUILD_ID` for instant registration while testing.

State (SQLite DB, session transcripts, workspaces) lives in the `claude-data` volume, so threads resume after redeploys.

To change bundles without rebuilding, uncomment the bind mount in `docker-compose.yml` (or use a Dokploy file mount at `/app/config/bundles.json`).

## 5. Use it

In a channel, an admin runs `/claude enable bundle:engineering`. Then anyone:

```
@Claude the signup form 500s when the email has a plus sign — find it and open a PR
@Claude summarise this channel's last week of discussion
@Claude every Monday at 9am, post a summary of open PRs in your-org/your-repo
@Claude from now on, answer in Japanese in this channel
```

Commands: `/claude status · enable · disable · reply · stop · reset · memory … · schedule … · auth · usage · bundles`.

## Security notes

- **Privilege separation.** The bot runs as root inside the container; every agent process (Claude Code and anything its shell runs) is launched as the unprivileged `agent` user via `setpriv`. The agent can't read the bot's environment (so not the Discord token), the database in `/data/bot`, or other root-owned files.
- **Tools are allow-listed per bundle** and run with `permissionMode: dontAsk`: anything not allowed is denied, never prompted.
- **The agent's environment is built from scratch**: one Claude credential, the bundle's GitHub token, and nothing else. In `code`/`github` bundles the shell can read those two, so use a dedicated API key with a Console spend limit (or accept that a plan token is visible to the shell) and a fine-grained, repo-scoped GitHub token.
- **Shared agent user.** All conversations run as the same `agent` user, so a `code` bundle's shell could read another channel's workspace or transcripts. Only enable `code`/`github` bundles where you trust the members, or restrict them with `allowedRoleIds`.
- **Admin-only actions stay admin-only** whether done by slash command or by asking Claude: server-wide memory, ambient mode, enabling bundles, switching credentials. Stopping, resetting and scheduling require access to the channel's bundle; cancelling a schedule requires being its creator or an admin.
- The bot never pings `@everyone`, `@here` or roles. Message text can't break out of the prompt's `<message>` wrapper.
- DMs are **off by default**. To enable, set `dm.bundle` in `bundles.json`, ideally with `dm.allowedUserIds`.

## Development

```
npm install
cp .env.example .env   # fill in, set DATA_DIR=./data and BUNDLES_FILE=./config/bundles.json
npm run dev
npm test
```
