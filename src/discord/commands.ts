import {
  ChannelType,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';
import type { Store, MemoryScope } from '../db.js';
import type { BundleRegistry, Effort } from '../bundles.js';
import { AUTH_LABEL, type AuthManager, type AuthMode } from '../auth.js';
import type { Config } from '../config.js';
import type { Scheduler } from '../scheduler.js';
import { builtinTools } from '../agent.js';
import { validateCron } from '../tools.js';
import { STOP_PREFIX, type RunManager } from './runs.js';
import { ASK_MENU, AskHandler, TRANSLATE_MENU, askKey, askMenuCommand, translateMenuCommand } from './ask.js';
import { hasAnyRole, isAdmin } from './util.js';
import { truncate } from '../format.js';
import { log, errMsg } from '../log.js';

export const command = new SlashCommandBuilder()
  .setName('claude')
  .setDescription('Configure and control Claude in this server')
  .addSubcommand((s) =>
    s
      .setName('ask')
      .setDescription('Ask Claude privately about this channel: only you see the question and the answer')
      .addStringOption((o) =>
        o.setName('prompt').setDescription('e.g. What are they discussing? Translate the last few messages.').setRequired(true).setMaxLength(4000),
      )
      .addBooleanOption((o) => o.setName('new').setDescription('Forget your earlier private questions here and start fresh')),
  )
  .addSubcommand((s) =>
    s
      .setName('enable')
      .setDescription('Admin: enable Claude in this channel with an access bundle')
      .addStringOption((o) => o.setName('bundle').setDescription('Access bundle').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((s) => s.setName('disable').setDescription('Admin: remove Claude from this channel'))
  .addSubcommand((s) => s.setName('status').setDescription("Show what Claude can access here and how it's configured"))
  .addSubcommand((s) =>
    s
      .setName('reply')
      .setDescription('Choose when Claude replies in this channel')
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('mention = only when tagged; ambient = may jump in unprompted (admin)')
          .setRequired(true)
          .addChoices({ name: 'Only when mentioned', value: 'mention' }, { name: 'Ambient (jump in when helpful)', value: 'ambient' }),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('threads')
      .setDescription('Admin: whether Claude opens a thread for each task in this channel')
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('off = reply in the channel (default); on = open a thread per task')
          .setRequired(true)
          .addChoices({ name: 'Off: reply in the channel', value: 'off' }, { name: 'On: open a thread per task', value: 'on' }),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('model')
      .setDescription('Admin: which Claude model works in this channel (bigger is better and costs more)')
      .addStringOption((o) =>
        o
          .setName('name')
          .setDescription("Model, or default to use the bundle's")
          .setRequired(true)
          .addChoices(
            { name: 'Opus 5.5: most capable', value: 'claude-opus-5-5' },
            { name: 'Sonnet 5.5: balanced', value: 'claude-sonnet-5-5' },
            { name: 'Haiku 5.5: fastest and cheapest', value: 'claude-haiku-5-5' },
            { name: "Default: use the bundle's model", value: 'default' },
          ),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('effort')
      .setDescription('Admin: how hard Claude thinks in this channel (higher is slower and costs more)')
      .addStringOption((o) =>
        o
          .setName('level')
          .setDescription("Effort level, or default to use the bundle's")
          .setRequired(true)
          .addChoices(
            { name: 'Low: quick answers', value: 'low' },
            { name: 'Medium', value: 'medium' },
            { name: 'High', value: 'high' },
            { name: 'Extra high', value: 'xhigh' },
            { name: 'Max: hardest problems', value: 'max' },
            { name: "Default: use the bundle's setting", value: 'default' },
          ),
      ),
  )
  .addSubcommand((s) => s.setName('stop').setDescription("Stop Claude's current work in this thread or channel"))
  .addSubcommand((s) => s.setName('reset').setDescription('Start a fresh session in this thread or DM (forgets the conversation)'))
  .addSubcommandGroup((g) =>
    g
      .setName('memory')
      .setDescription('Standing instructions Claude follows here')
      .addSubcommand((s) => s.setName('list').setDescription('Show channel and server memory'))
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add a standing instruction')
          .addStringOption((o) => o.setName('text').setDescription('The instruction').setRequired(true).setMaxLength(500))
          .addStringOption((o) =>
            o
              .setName('scope')
              .setDescription('Channel (default) or whole server (admin)')
              .addChoices({ name: 'This channel', value: 'channel' }, { name: 'Whole server', value: 'guild' }),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('forget')
          .setDescription('Delete one memory by id')
          .addIntegerOption((o) => o.setName('id').setDescription('Memory id').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('clear')
          .setDescription('Admin: delete all memory for this channel or server')
          .addStringOption((o) =>
            o
              .setName('scope')
              .setDescription('What to clear')
              .setRequired(true)
              .addChoices({ name: 'This channel', value: 'channel' }, { name: 'Whole server', value: 'guild' }),
          ),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('schedule')
      .setDescription('Standing work that runs on a schedule')
      .addSubcommand((s) => s.setName('list').setDescription('List schedules in this channel'))
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add a scheduled task (or just ask Claude in plain words)')
          .addStringOption((o) => o.setName('cron').setDescription('Cron, e.g. "0 9 * * 1-5"').setRequired(true))
          .addStringOption((o) => o.setName('prompt').setDescription('Standalone instruction for each run').setRequired(true).setMaxLength(4000))
          .addStringOption((o) => o.setName('description').setDescription('Short label').setMaxLength(200))
          .addStringOption((o) => o.setName('timezone').setDescription('IANA timezone, e.g. Asia/Tokyo')),
      )
      .addSubcommand((s) =>
        s
          .setName('cancel')
          .setDescription('Cancel a schedule')
          .addIntegerOption((o) => o.setName('id').setDescription('Schedule id').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('run')
          .setDescription('Run a schedule now')
          .addIntegerOption((o) => o.setName('id').setDescription('Schedule id').setRequired(true)),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('auth')
      .setDescription('Admin: switch between API key and Claude plan sign-in')
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('Credential to use')
          .setRequired(true)
          .addChoices(
            { name: 'API key (pay-as-you-go / plan monthly API credits)', value: 'api_key' },
            { name: 'Claude plan sign-in (plan usage limits)', value: 'oauth_token' },
            { name: 'Default from environment', value: 'default' },
          ),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('usage')
      .setDescription('Admin: runs and estimated cost')
      .addIntegerOption((o) => o.setName('days').setDescription('Look-back window (default 30)').setMinValue(1).setMaxValue(365)),
  )
  .addSubcommand((s) => s.setName('bundles').setDescription('Admin: list access bundles'));

export async function registerCommands(cfg: Config): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(cfg.DISCORD_TOKEN);
  const body = [command.toJSON(), askMenuCommand.toJSON(), translateMenuCommand.toJSON()];
  if (cfg.DEV_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(cfg.DISCORD_APP_ID, cfg.DEV_GUILD_ID), { body });
    log.info('registered guild commands', { guild: cfg.DEV_GUILD_ID });
  } else {
    await rest.put(Routes.applicationCommands(cfg.DISCORD_APP_ID), { body });
    log.info('registered global commands');
  }
}

export interface CommandDeps {
  client: Client;
  store: Store;
  bundles: BundleRegistry;
  auth: AuthManager;
  cfg: Config;
  runs: RunManager;
  scheduler: Scheduler;
}

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export class CommandHandler {
  private readonly ask: AskHandler;

  constructor(private readonly d: CommandDeps) {
    this.ask = new AskHandler(d);
  }

  async onInteraction(i: Interaction): Promise<void> {
    try {
      if (i.isAutocomplete()) return await this.autocomplete(i);
      if (i.isButton() && i.customId.startsWith(STOP_PREFIX)) return await this.stopButton(i);
      if (i.isMessageContextMenuCommand() && (i.commandName === ASK_MENU || i.commandName === TRANSLATE_MENU)) return await this.ask.menu(i);
      if (i.isModalSubmit() && this.ask.isModal(i.customId)) return await this.ask.modal(i);
      if (i.isChatInputCommand() && i.commandName === 'claude') return await this.command(i);
    } catch (e) {
      log.error('interaction failed', { error: errMsg(e) });
      const content = `⚠️ ${truncate(errMsg(e), 300)}`;
      if (i.isRepliable() && !i.replied && !i.deferred) await i.reply({ content, ...EPHEMERAL }).catch(() => {});
      else if (i.isRepliable() && i.deferred && !i.replied) await i.editReply({ content }).catch(() => {});
    }
  }

  private async autocomplete(i: AutocompleteInteraction) {
    const q = i.options.getFocused().toLowerCase();
    const names = this.d.bundles.names().filter((n) => n.toLowerCase().includes(q)).slice(0, 25);
    await i.respond(names.map((n) => ({ name: truncate(`${n} — ${this.d.bundles.get(n)?.description ?? ''}`, 100), value: n })));
  }

  private async stopButton(i: ButtonInteraction) {
    const key = i.customId.slice(STOP_PREFIX.length);
    if (!this.canWorkHere(i, this.configChannelId(i))) {
      await i.reply({ content: "You don't have access to Claude's work in this channel.", ...EPHEMERAL });
      return;
    }
    const ok = this.d.runs.stop(key);
    await i.reply({ content: ok ? '⏹️ Stopping…' : 'Nothing is running here.', ...EPHEMERAL });
  }

  /** Channel whose config applies: parent for threads, the DM channel for DMs. */
  private configChannelId(i: ChatInputCommandInteraction | ButtonInteraction): string {
    const ch = i.channel;
    if (ch?.isThread() && ch.parentId) return ch.parentId;
    return i.channelId;
  }

  private admin(i: ChatInputCommandInteraction | ButtonInteraction): boolean {
    return !!i.guild && isAdmin(this.d.cfg, i.user.id, i.member);
  }

  /** Could this user hand Claude work here? (Admins always; in DMs it's their own conversation.) */
  private canWorkHere(i: ChatInputCommandInteraction | ButtonInteraction, channelId: string): boolean {
    if (!i.guild) return true;
    if (this.admin(i)) return true;
    const ch = this.d.store.getChannel(channelId);
    const bundle = ch ? this.d.bundles.get(ch.bundle) : undefined;
    return !!bundle && hasAnyRole(i.member, bundle.allowedRoleIds);
  }

  private async command(i: ChatInputCommandInteraction) {
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand();
    const { store, bundles, auth, cfg } = this.d;
    const channelId = this.configChannelId(i);
    const needAdmin = async () => {
      if (this.admin(i)) return true;
      await i.reply({ content: 'This needs **Manage Server** or a configured admin role.', ...EPHEMERAL });
      return false;
    };
    const needGuild = async () => {
      if (i.guild) return true;
      await i.reply({ content: 'Use this in a server channel.', ...EPHEMERAL });
      return false;
    };

    if (sub === 'ask' && !group) return this.ask.slash(i);
    if (group === 'memory') return this.memory(i, sub, channelId, needAdmin);
    if (group === 'schedule') return this.schedule(i, sub, channelId);

    switch (sub) {
      case 'enable': {
        if (!(await needGuild()) || !(await needAdmin())) return;
        const inForumPost = i.channel?.isThread() && i.channel.parent?.type === ChannelType.GuildForum;
        if (i.channel?.isThread() && !inForumPost) {
          await i.reply({ content: 'Run this in the parent channel, not a thread. (For a forum, run it inside any post.)', ...EPHEMERAL });
          return;
        }
        if (!inForumPost && i.channel && i.channel.type !== ChannelType.GuildText && i.channel.type !== ChannelType.GuildAnnouncement) {
          await i.reply({ content: 'Claude works in text, announcement and forum channels.', ...EPHEMERAL });
          return;
        }
        const name = i.options.getString('bundle', true);
        const bundle = bundles.get(name);
        if (!bundle) {
          await i.reply({ content: `No bundle named "${name}". Available: ${bundles.names().join(', ')}`, ...EPHEMERAL });
          return;
        }
        store.enableChannel(channelId, i.guild!.id, name, i.user.id);
        await i.reply(
          `✅ Claude is enabled here with the **${name}** bundle (${bundle.capabilities.join(', ')}${
            Object.keys(bundle.mcpServers).length ? `, ${Object.keys(bundle.mcpServers).join(', ')}` : ''
          }). Tag <@${this.d.client.user!.id}> with a task to get started.`,
        );
        return;
      }
      case 'disable': {
        if (!(await needGuild()) || !(await needAdmin())) return;
        const ok = store.disableChannel(channelId);
        await i.reply(ok ? '👋 Claude is removed from this channel. Schedules here will stop running.' : { content: 'Claude was not enabled here.', ...EPHEMERAL });
        return;
      }
      case 'status':
        return this.status(i, channelId);
      case 'reply': {
        if (!(await needGuild())) return;
        const mode = i.options.getString('mode', true) as 'mention' | 'ambient';
        if (mode === 'ambient' && !(await needAdmin())) return;
        const ok = store.setReplyMode(channelId, mode, i.user.id);
        if (!ok) {
          await i.reply({ content: 'Claude is not enabled in this channel.', ...EPHEMERAL });
          return;
        }
        await i.reply(
          mode === 'ambient'
            ? `🔔 Ambient mode on: Claude may jump in when it can clearly help (max ${bundles.ambient.maxPerHour}/hour).`
            : '🔕 Claude will only reply when mentioned or in its own threads.',
        );
        return;
      }
      case 'threads': {
        if (!(await needGuild()) || !(await needAdmin())) return;
        const on = i.options.getString('mode', true) === 'on';
        if (!store.setThreads(channelId, on, i.user.id)) {
          await i.reply({ content: 'Claude is not enabled in this channel.', ...EPHEMERAL });
          return;
        }
        await i.reply(
          on
            ? '🧵 Claude will open a thread for each task here.'
            : '💬 Claude will reply in the channel. Reply to one of its messages to continue, or start a thread yourself and tag it there.',
        );
        return;
      }
      case 'model': {
        if (!(await needGuild()) || !(await needAdmin())) return;
        const name = i.options.getString('name', true);
        const model = name === 'default' ? null : name;
        if (!store.setModel(channelId, model, i.user.id)) {
          await i.reply({ content: 'Claude is not enabled in this channel.', ...EPHEMERAL });
          return;
        }
        const bundleModel = bundles.get(store.getChannel(channelId)!.bundle)?.model ?? cfg.CLAUDE_MODEL;
        await i.reply(
          model
            ? `🤖 Claude now uses **${model}** in this channel. Applies to new work.`
            : `🤖 This channel now uses the bundle's model: **${bundleModel}**.`,
        );
        return;
      }
      case 'effort': {
        if (!(await needGuild()) || !(await needAdmin())) return;
        const level = i.options.getString('level', true);
        const effort = level === 'default' ? null : (level as Effort);
        if (!store.setEffort(channelId, effort, i.user.id)) {
          await i.reply({ content: 'Claude is not enabled in this channel.', ...EPHEMERAL });
          return;
        }
        const bundleEffort = bundles.get(store.getChannel(channelId)!.bundle)?.effort;
        await i.reply(
          effort
            ? `🧠 Effort here is now **${effort}**. Applies to new work.`
            : `🧠 Effort here now follows the bundle: **${bundleEffort ?? "the model's default"}**.`,
        );
        return;
      }
      case 'stop': {
        if (!this.canWorkHere(i, channelId)) {
          await i.reply({ content: "You don't have access to Claude's work in this channel.", ...EPHEMERAL });
          return;
        }
        // In a channel, inline conversations have no thread of their own: stop everything running here.
        const ok =
          this.d.runs.stop(askKey(i.channelId, i.user.id)) ||
          this.d.runs.stop(i.channelId) ||
          (!i.channel?.isThread() && this.d.runs.stopChannel(i.channelId) > 0);
        await i.reply({ content: ok ? '⏹️ Stopping…' : 'Nothing is running here.', ...EPHEMERAL });
        return;
      }
      case 'reset': {
        if (!this.canWorkHere(i, channelId)) {
          await i.reply({ content: "You don't have access to Claude's work in this channel.", ...EPHEMERAL });
          return;
        }
        if (this.d.runs.isBusy(i.channelId)) {
          await i.reply({ content: 'Claude is working here; stop it first.', ...EPHEMERAL });
          return;
        }
        const ok = store.clearThreadSession(i.channelId);
        await i.reply(ok ? '🧹 Fresh start: the next message begins a new session. Memory is kept.' : { content: 'No session here to reset.', ...EPHEMERAL });
        return;
      }
      case 'auth': {
        if (!(await needGuild()) || !(await needAdmin())) return;
        const choice = i.options.getString('mode', true);
        try {
          if (choice === 'default') auth.reset();
          else auth.setMode(choice as AuthMode);
        } catch (e) {
          await i.reply({ content: `⚠️ ${errMsg(e)}`, ...EPHEMERAL });
          return;
        }
        log.info('auth mode changed', { by: i.user.id, mode: auth.mode() });
        await i.reply({
          content: `🔑 Claude now uses: **${AUTH_LABEL[auth.mode()]}**. Applies to new work; anything running finishes on the old credential.`,
          ...EPHEMERAL,
        });
        return;
      }
      case 'usage': {
        if (!(await needGuild()) || !(await needAdmin())) return;
        const days = i.options.getInteger('days') ?? 30;
        const u = store.usageSince(i.guild!.id, Date.now() - days * 86400_000);
        const note =
          auth.mode() === 'oauth_token'
            ? '\n_On plan sign-in, cost is an estimate only; usage counts against your plan limits._'
            : '\n_Estimated from the SDK; the Claude Console has the authoritative bill._';
        await i.reply({ content: `📊 Last ${days} days: **${u.runs}** runs, est. **$${u.cost.toFixed(2)}**.${note}`, ...EPHEMERAL });
        return;
      }
      case 'bundles': {
        if (!(await needGuild()) || !(await needAdmin())) return;
        const lines = bundles.names().map((n) => {
          const b = bundles.get(n)!;
          const mcp = Object.keys(b.mcpServers);
          return `• **${n}**: ${b.description || '—'}\n  ${b.capabilities.join(', ')}${mcp.length ? ` · MCP: ${mcp.join(', ')}` : ''} · ≤${b.maxTurns} steps · ≤$${b.maxBudgetUsd}/task${
            b.allowedRoleIds.length ? ' · role-restricted' : ''
          }`;
        });
        await i.reply({ content: truncate(lines.join('\n'), 1900) || 'No bundles defined.', ...EPHEMERAL });
        return;
      }
    }
    void cfg;
  }

  private async status(i: ChatInputCommandInteraction, channelId: string) {
    const { store, bundles, auth, cfg } = this.d;
    const lines: string[] = [];
    let bundleName: string | null = null;
    if (i.guild) {
      const ch = store.getChannel(channelId);
      if (!ch) {
        await i.reply({ content: 'Claude is not enabled in this channel. An admin can run `/claude enable`.', ...EPHEMERAL });
        return;
      }
      bundleName = ch.bundle;
      lines.push(
        `**Bundle:** ${ch.bundle} · **Replies:** ${ch.reply_mode === 'ambient' ? 'ambient' : 'only when mentioned'} · **Threads:** ${ch.threads ? 'one per task' : 'off (replies in channel)'}`,
      );
    } else {
      bundleName = bundles.dm.bundle;
      lines.push(`**DM bundle:** ${bundleName ?? 'DMs disabled'}`);
    }
    const b = bundleName ? bundles.get(bundleName) : undefined;
    if (b) {
      const tools = builtinTools(b);
      lines.push(`**Can use:** ${tools.length ? tools.join(', ') : 'no built-in tools'}${Object.keys(b.mcpServers).length ? ` · MCP: ${Object.keys(b.mcpServers).join(', ')}` : ''}`);
      if (b.skills.length) lines.push(`**Skills:** ${b.skills === 'all' ? 'all' : b.skills.join(', ')}`);
      if (b.github) lines.push(`**Repos:** ${b.github.repos.join(', ') || 'any the token can reach'}`);
      const ch = i.guild ? store.getChannel(channelId) : undefined;
      const effort = ch?.effort ? `${ch.effort} (this channel)` : b.effort ? `${b.effort} (bundle)` : 'model default';
      const model = ch?.model ? `${ch.model} (this channel)` : b.model ? `${b.model} (bundle)` : cfg.CLAUDE_MODEL;
      lines.push(`**Model:** ${model} · **Effort:** ${effort} · **Limits:** ${b.maxTurns} steps, $${b.maxBudgetUsd}/task`);
    }
    lines.push(`**Credential:** ${AUTH_LABEL[auth.mode()]}`);
    const mem = store.listMemories('channel', channelId).length + (i.guild ? store.listMemories('guild', i.guild.id).length : 0);
    const sched = store.listSchedules({ channelId }).length;
    lines.push(`**Memory:** ${mem} item${mem === 1 ? '' : 's'} · **Schedules:** ${sched} · **Running now:** ${this.d.runs.activeCount}`);
    await i.reply({ content: lines.join('\n'), ...EPHEMERAL });
  }

  private async memory(i: ChatInputCommandInteraction, sub: string, channelId: string, needAdmin: () => Promise<boolean>) {
    const { store } = this.d;
    const guildId = i.guild?.id ?? null;
    switch (sub) {
      case 'list': {
        const rows = [
          ...(guildId ? store.listMemories('guild', guildId) : []),
          ...store.listMemories('channel', channelId),
        ];
        await i.reply({
          content: rows.length ? truncate(rows.map((r) => `#${r.id} [${r.scope === 'guild' ? 'server' : 'channel'}] ${r.content}`).join('\n'), 1900) : 'No memory saved yet.',
          ...EPHEMERAL,
        });
        return;
      }
      case 'add': {
        const scope = (i.options.getString('scope') ?? 'channel') as MemoryScope;
        if (scope === 'guild' && (!guildId || !(await needAdmin()))) return;
        const row = store.addMemory(scope, scope === 'guild' ? guildId! : channelId, i.options.getString('text', true), i.user.id);
        await i.reply(`🧠 Saved memory #${row.id} (${scope === 'guild' ? 'server' : 'channel'}).`);
        return;
      }
      case 'forget': {
        const id = i.options.getInteger('id', true);
        const allowed: Array<{ scope: MemoryScope; scopeId: string }> = [{ scope: 'channel', scopeId: channelId }];
        if (guildId && this.admin(i)) allowed.push({ scope: 'guild', scopeId: guildId });
        const ok = store.deleteMemory(id, allowed);
        await i.reply(ok ? `🧠 Deleted memory #${id}.` : { content: `No memory #${id} you can delete here.`, ...EPHEMERAL });
        return;
      }
      case 'clear': {
        const scope = i.options.getString('scope', true) as MemoryScope;
        if (scope === 'guild' && !guildId) {
          await i.reply({ content: 'There is no server memory in DMs.', ...EPHEMERAL });
          return;
        }
        // In a DM the "channel" is the user's own conversation; elsewhere clearing needs admin.
        if (guildId && !(await needAdmin())) return;
        const n = store.clearMemories(scope, scope === 'guild' ? guildId! : channelId);
        await i.reply(`🧠 Cleared ${n} memor${n === 1 ? 'y' : 'ies'}.`);
        return;
      }
    }
  }

  private async schedule(i: ChatInputCommandInteraction, sub: string, channelId: string) {
    const { store, cfg, scheduler } = this.d;
    if (!i.guild) {
      await i.reply({ content: 'Schedules work in server channels.', ...EPHEMERAL });
      return;
    }
    if (!store.getChannel(channelId)) {
      await i.reply({ content: 'Claude is not enabled in this channel.', ...EPHEMERAL });
      return;
    }
    const denied = async () => {
      await i.reply({ content: "You don't have a role that can hand Claude work in this channel.", ...EPHEMERAL });
    };
    switch (sub) {
      case 'list': {
        const rows = store.listSchedules({ channelId });
        const text = rows
          .map((r) => {
            const next = scheduler.nextRun(r.id);
            return `#${r.id} **${r.description || truncate(r.prompt, 60)}** · \`${r.cron}\` ${r.tz}${next ? ` · next <t:${Math.floor(next.getTime() / 1000)}:R>` : ''}`;
          })
          .join('\n');
        await i.reply({ content: text || 'No schedules here. Ask Claude something like "every weekday at 9am, summarise yesterday\'s messages".', ...EPHEMERAL });
        return;
      }
      case 'add': {
        if (!this.canWorkHere(i, channelId)) return denied();
        const cron = i.options.getString('cron', true);
        const tz = i.options.getString('timezone') ?? cfg.DEFAULT_TIMEZONE;
        const v = validateCron(cron, tz);
        if (!v.ok) {
          await i.reply({ content: `⚠️ Invalid schedule: ${v.error}`, ...EPHEMERAL });
          return;
        }
        const prompt = i.options.getString('prompt', true);
        const row = store.addSchedule({
          guild_id: i.guild.id,
          channel_id: channelId,
          cron,
          tz,
          prompt,
          description: i.options.getString('description') ?? truncate(prompt, 60),
          created_by: i.user.id,
        });
        scheduler.reload();
        const next = v.next ? ` Next run <t:${Math.floor(v.next.getTime() / 1000)}:F>.` : '';
        await i.reply(`🗓️ Created schedule #${row.id} (\`${cron}\`, ${tz}).${next}`);
        return;
      }
      case 'cancel': {
        const id = i.options.getInteger('id', true);
        const existing = store.getSchedule(id);
        if (existing && existing.channel_id === channelId && existing.created_by !== i.user.id && !this.admin(i)) {
          await i.reply({ content: 'Only the person who created this schedule or an admin can cancel it.', ...EPHEMERAL });
          return;
        }
        const ok = store.deleteSchedule(id, channelId);
        if (ok) scheduler.reload();
        await i.reply(ok ? `🗓️ Cancelled schedule #${id}.` : { content: `No schedule #${id} in this channel.`, ...EPHEMERAL });
        return;
      }
      case 'run': {
        if (!this.canWorkHere(i, channelId)) return denied();
        const id = i.options.getInteger('id', true);
        const row = store.getSchedule(id);
        if (!row || row.channel_id !== channelId) {
          await i.reply({ content: `No schedule #${id} in this channel.`, ...EPHEMERAL });
          return;
        }
        await i.reply({ content: `▶️ Running schedule #${id} now.`, ...EPHEMERAL });
        await scheduler.fire(id);
        return;
      }
    }
  }
}
