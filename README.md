# zClaude for Discord

The bot goes by **zClaude** (it runs on Anthropic's Claude). Its replies, the right-click entries and the way it introduces itself use the bot's name in Discord, so renaming the bot in the Developer Portal is enough to change them; the slash command is `/zclaude`.

A Claude Tag–style teammate for Discord, built on the [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview). Tag `@zClaude` in a channel and it works through the task with the tools its channel allows, then replies right there. Reply to its message to keep going, or start a thread yourself and tag it there. Channels can opt in to a thread per task instead.

## What it does

| Claude Tag feature | Here |
|---|---|
| Tag `@zClaude` to hand off work | Mention → live progress with a **Stop** button → result, posted as a reply in the channel. Using Discord's **Reply** on any of Claude's messages continues that conversation; a new tag starts a fresh one (with recent channel messages as context). Messages sent mid-run are batched into the next turn. |
| Threads | Start a thread yourself and tag Claude in it: it joins, and follow-ups there go to Claude without re-tagging. `/zclaude threads mode:on` makes Claude open a thread for every task in that channel instead. |
| Access bundles per channel | `config/bundles.json` defines bundles (web, code, GitHub, MCP servers, role limits, step/budget caps). Admins attach one per channel with `/zclaude enable`. |
| Channel memory | "From now on…" instructions are saved per channel or server and fed into every session. Manage with `/zclaude memory`. |
| Ambient behaviour | `/zclaude reply mode:ambient` lets Claude jump in when a small model judges it can clearly help. Rate-limited per channel. |
| Standing scheduled work | "Every weekday at 9am, summarise yesterday" → a cron schedule that posts each run in the channel (or in a fresh thread when threads are on) (text and announcement channels; not forums). |
| Private questions | `/zclaude ask` asks Claude about the channel so only you see it: the command, your prompt and the answer are hidden from everyone else. Or right-click a message → **Apps** → **Ask zClaude privately** to ask about the conversation from that message on (e.g. "what are they saying? translate and explain the tone"). **Translate from here** (same menu) skips the question and privately translates the conversation from that message on into your Discord language, with a gist and notes on tone. Follow-up asks in the same channel continue your private session; `new:true` starts over. |
| Quieting | "Stop replying here" → quiet thread or reply chain; `/zclaude reply mode:mention` → mention-only. |
| DMs | Optional (off by default), on their own bundle. |
| Switchable credential | API key or Claude plan sign-in; flip live with `/zclaude auth`. |

## 1. Create the Discord app

1. <https://discord.com/developers/applications> → **New Application**. Copy the **Application ID** → `DISCORD_APP_ID`.
2. **Bot** tab → **Reset Token** → `DISCORD_TOKEN`. Turn on **Message Content Intent**.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Attach Files, Add Reactions, Embed Links.
4. **Invite the bot**: open the generated URL in your browser, pick your server and click **Authorize**. You need Manage Server on that server. The bot now appears in the member list but stays **offline** until you deploy it in step 4.

## 2. Choose a Claude credential

Set one or both in the environment:

- **`ANTHROPIC_API_KEY`** (default). Pay-as-you-go, **or your Max/Team plan's monthly API credits**: claim them in claude.ai billing settings into a linked Claude Console org, then create the key in that org. Requests stop when credits run out unless the org has purchased credits or auto-reload.
- **`CLAUDE_CODE_OAUTH_TOKEN`**. Run `claude setup-token` and paste the token. Uses your plan's own usage limits, not the monthly credits. It's tied to one person's account, so check Anthropic's terms before running a shared server on it.

With both set, admins switch at any time with `/zclaude auth` (persists across restarts; `default` returns to `AUTH_MODE`). The agent only ever receives one credential, so it's always clear which pool pays.

## 3. Configure access bundles

Edit `config/bundles.json`. Capabilities:

- `web`: WebSearch, WebFetch
- `code`: shell and file tools in a per-thread working directory
- `github`: `code` plus `git`/`gh` authenticated with the token in `github.tokenEnv`. Use a **fine-grained PAT scoped to the listed repos**: that's the real enforcement.
- `mcpServers`: any stdio/http/sse MCP servers; `${VAR}` is replaced from the environment.

Also per bundle: `allowedRoleIds`, `model`, `effort`, `maxTurns`, `maxBudgetUsd`, `instructions`, `skills`.

`effort` (`low`, `medium`, `high`, `xhigh` or `max`) sets how hard Claude thinks; higher is slower and costs more. Leave it out for `medium`. Opus runs at most at `high`: `xhigh` and `max` are lowered to `high` on Opus wherever they come from. `maxBudgetUsd` is an optional spend cap per task; by default there is none, so a big task isn't cut off midway (`maxTurns` still limits steps). Admins can override it per channel with `/zclaude effort`, and the model with `/zclaude model` (Opus, Sonnet or Haiku; `default` goes back to the bundle's). The file is re-read automatically when it changes.

### Skills

Team skills live in `config/plugin/skills/<name>/SKILL.md` (a local Claude Code plugin named `team`). A bundle lists the ones Claude may use, by folder name, or `"all"`:

```json
"skills": ["project-estimation"]
```

Skills need the `code` capability, because Claude reads a skill's reference files with its file tools. Included:

- `project-estimation`: rough pre-signing estimate of a client project from a requirements doc (time, human vs AI effort, architecture, risks), written in Japanese. Enabled on `analysis` and `engineering`.

To add one, put its folder under `config/plugin/skills/`, add its name to a bundle and redeploy.

## 4. Deploy on Dokploy

1. Push this folder to a Git repo.
2. Dokploy → **Create Service → Compose** → point it at the repo (compose file `docker-compose.yml`).
3. **Environment** tab: add the variables below as `KEY=value` lines. Dokploy writes them to a `.env` file next to the compose file, which `docker-compose.yml` loads with `env_file`.
4. Deploy. Logs should show `agent isolation {"runAs":"agent"}` and `connected to Discord`. Global slash commands can take a few minutes to appear; set `DEV_GUILD_ID` for instant registration while testing.

### Environment variables

**Required**

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Bot token from the Discord app's **Bot** tab. |
| `DISCORD_APP_ID` | Application ID from the Discord app's **General Information** page. |
| `ANTHROPIC_API_KEY` *and/or* `CLAUDE_CODE_OAUTH_TOKEN` | At least one Claude credential (see [step 2](#2-choose-a-claude-credential)). The bot refuses to start with neither. |

**Needed depending on your bundles**

| Variable | When |
|---|---|
| `GITHUB_TOKEN` | Any bundle with the `github` capability (or whatever name its `github.tokenEnv` gives). Fine-grained PAT on the listed repos: Contents read/write, Pull requests read/write, Metadata read. |
| Any `${VAR}` in `bundles.json` | MCP server secrets, e.g. `LINEAR_API_KEY` for the example `ops-example-with-mcp` bundle. |

**Optional**

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_MODE` | `api_key` if `ANTHROPIC_API_KEY` is set, else `oauth_token` | Which credential to use when both are set. Admins can override live with `/zclaude auth`. |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model for working sessions (a bundle's `model` overrides it). |
| `AMBIENT_MODEL` | `claude-haiku-5-5` | Small model that decides whether to jump in during ambient mode. |
| `ADMIN_ROLE_IDS` | – | Comma-separated role IDs allowed to run admin commands, besides anyone with Manage Server. |
| `ADMIN_USER_IDS` | – | Comma-separated user IDs, same as above. |
| `DEV_GUILD_ID` | – | Register slash commands to one server instantly instead of globally. |
| `DEFAULT_TIMEZONE` | `UTC` | IANA timezone for schedules that don't name one, e.g. `Europe/London`. |
| `MAX_CONCURRENT_RUNS` | `4` | Runs allowed at once across the whole bot. |
| `CONTEXT_MESSAGES` | `25` | Recent channel messages (0–100) given as context when tagged. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `ANTHROPIC_BASE_URL` | – | Network settings passed through to the agent, only if your host needs them. |

**Finding Discord IDs.** Turn on Developer Mode (User Settings → Advanced → Developer Mode), then right-click:

- a person's name or avatar → **Copy User ID** (for `ADMIN_USER_IDS`)
- a role in Server Settings → Roles → **Copy Role ID** (for `ADMIN_ROLE_IDS`)
- the server icon → **Copy Server ID** (for `DEV_GUILD_ID`)

Separate several IDs with commas, no quotes. Leaving the admin lists empty is fine: anyone with Manage Server is already an admin.

Don't set `DATA_DIR` or `BUNDLES_FILE` in Dokploy: `docker-compose.yml` already sets them to the volume and the bundled config.

A minimal setup looks like this:

```
DISCORD_TOKEN=...
DISCORD_APP_ID=...
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=github_pat_...
ADMIN_USER_IDS=123456789012345678
DEFAULT_TIMEZONE=Europe/London
```

State (SQLite DB, session transcripts, workspaces) lives in the `claude-data` volume, so threads resume after redeploys.

To change bundles without rebuilding, uncomment the bind mount in `docker-compose.yml` (or use a Dokploy file mount at `/app/config/bundles.json`).

## 5. Use it

Once the deploy is running, the bot you invited in step 1 shows as **online** in your server, and typing `/zclaude` lists its commands. If it's still offline, check the Dokploy logs. If it isn't in the member list at all, go back to step 1.4 and invite it.

In a channel, an admin runs `/zclaude enable bundle:engineering`. Then anyone:

```
@zClaude the signup form 500s when the email has a plus sign — find it and open a PR
@zClaude summarise this channel's last week of discussion
@zClaude every Monday at 9am, post a summary of open PRs in your-org/your-repo
@zClaude from now on, answer in Japanese in this channel
@zClaude --sonnet --low summarise today's discussion
@zClaude --opus --high why does the payment webhook double-charge?
```

Flags at the start of a message pick the model (`--opus`, `--sonnet`, `--haiku`) and effort (`--low`, `--medium`, `--high`, `--xhigh`, `--max`) for that one run, over the channel's settings. Anyone can use them; Opus still caps at `high`. The progress message shows what's in use (`⏳ Working on it… · sonnet · low`). `/zclaude ask` has the same choices as `model` and `effort` options.

Commands: `/zclaude ask · status · enable · disable · reply · threads · model · effort · stop · reset · memory … · schedule … · auth · usage · bundles`.

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
