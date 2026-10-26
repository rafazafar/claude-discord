import {
  ChannelType,
  MessageReferenceType,
  type Client,
  type Message,
  type SendableChannels,
  type TextBasedChannel,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import type { Store, ChannelRow, ThreadRow } from '../db.js';
import type { BundleRegistry } from '../bundles.js';
import type { AuthManager } from '../auth.js';
import type { Config } from '../config.js';
import type { RunManager, Trigger, WorkItem } from './runs.js';
import { shouldJumpIn } from '../ambient.js';
import { threadTitle } from '../format.js';
import { fetchLines, hasAnyRole, isAdmin, stripBotMention, workspaceFor } from './util.js';
import { log, errMsg } from '../log.js';
import { parseRunFlags } from '../flags.js';
import { botName } from '../botname.js';

export interface HandlerDeps {
  client: Client;
  store: Store;
  bundles: BundleRegistry;
  auth: AuthManager;
  cfg: Config;
  runs: RunManager;
}

const NOT_ENABLED =
  "I'm not set up in this channel yet. Someone with **Manage Server** can run `/zclaude enable` here to choose what I can access.";

export class MessageHandler {
  private readonly lastAmbientCheck = new Map<string, number>();
  private readonly ambientInflight = new Set<string>();

  constructor(private readonly d: HandlerDeps) {}

  private get botId(): string {
    return this.d.client.user!.id;
  }

  private isMentioned(m: Message): boolean {
    if (m.mentions.users.has(this.botId)) return true;
    const botRole = m.guild?.members.me?.roles.botRole?.id;
    return !!botRole && m.mentions.roles.has(botRole);
  }

  async onMessage(m: Message): Promise<void> {
    if (m.author.bot || m.system || m.author.id === this.botId) return;
    try {
      if (!m.guild) return await this.onDM(m);
      if (m.channel.isThread()) return await this.onThreadMessage(m, m.channel);
      return await this.onChannelMessage(m);
    } catch (e) {
      log.error('message handling failed', { error: errMsg(e), channel: m.channelId });
    }
  }

  private baseItem(m: Message, trigger: Trigger, bundleName: string, configChannel: { id: string; name: string }): Omit<WorkItem, 'key' | 'getChannel' | 'contextLines' | 'fetchHistory'> {
    const flags = parseRunFlags(stripBotMention(m.content, this.botId));
    return {
      trigger,
      guildId: m.guild?.id ?? null,
      guildName: m.guild?.name ?? null,
      configChannelId: configChannel.id,
      configChannelName: configChannel.name,
      bundleName,
      userId: m.author.id,
      userName: m.member?.displayName ?? m.author.displayName ?? m.author.username,
      isAdmin: !!m.guild && isAdmin(this.d.cfg, m.author.id, m.member),
      content: flags.rest,
      modelOverride: flags.model,
      effortOverride: flags.effort,
      attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url, size: a.size })),
      sourceMessage: m,
    };
  }

  private async deny(m: Message, text: string) {
    try {
      const r = await m.reply({ content: text, allowedMentions: { repliedUser: false } });
      setTimeout(() => r.delete().catch(() => {}), 20_000);
    } catch {
      /* ignore */
    }
  }

  // ---- DMs ------------------------------------------------------------------

  private async onDM(m: Message) {
    const dm = this.d.bundles.dm;
    if (!dm.bundle) {
      await m.reply("Direct messages are turned off for this bot. Tag me in a server channel instead.").catch(() => {});
      return;
    }
    if (dm.allowedUserIds.length && !dm.allowedUserIds.includes(m.author.id)) {
      await m.reply("You're not on the list of people who can DM this bot.").catch(() => {});
      return;
    }
    const key = m.channel.id;
    this.d.store.createThread({
      thread_id: key,
      parent_channel_id: key,
      guild_id: null,
      cwd: workspaceFor(this.d.cfg, null, key, m.author.id),
      bundle: dm.bundle,
    });
    const channel = m.channel as SendableChannels;
    this.d.runs.enqueue({
      ...this.baseItem(m, 'dm', dm.bundle, { id: key, name: 'direct-message' }),
      key,
      contextLines: [],
      getChannel: async () => channel,
      fetchHistory: (limit) => fetchLines(m.channel as TextBasedChannel, limit),
    });
  }

  // ---- threads ----------------------------------------------------------------

  private async onThreadMessage(m: Message, thread: ThreadChannel) {
    const parentId = thread.parentId;
    if (!parentId) return;
    const mentioned = this.isMentioned(m);
    const ch = this.d.store.getChannel(parentId);
    if (!ch) {
      if (mentioned) await this.deny(m, NOT_ENABLED);
      return;
    }
    const bundle = this.d.bundles.get(ch.bundle);
    if (!bundle) return;

    let row = this.d.store.getThread(thread.id);
    if (!row && !mentioned) return; // a thread Claude isn't part of yet: join only when tagged
    if (row?.quiet && !mentioned) return;
    if (!hasAnyRole(m.member, bundle.allowedRoleIds)) {
      // Only answer people who addressed Claude; ordinary chat in the thread is left alone.
      if (mentioned) await this.deny(m, "You don't have a role that can hand me work in this channel.");
      return;
    }

    let contextLines: string[] = [];
    if (!row) {
      row = this.d.store.createThread({
        thread_id: thread.id,
        parent_channel_id: parentId,
        guild_id: m.guild!.id,
        cwd: workspaceFor(this.d.cfg, m.guild!.id, parentId, thread.id),
        bundle: ch.bundle,
      });
      contextLines = await fetchLines(thread as unknown as TextBasedChannel, this.d.cfg.CONTEXT_MESSAGES, m.id).catch(() => []);
      const starter = await thread.fetchStarterMessage().catch(() => null);
      // In a forum post the starter is often this very message; don't repeat it as context.
      if (starter && starter.id !== m.id && !contextLines.length) contextLines = [`(thread started from) ${starter.cleanContent}`];
    } else if (row.quiet) {
      this.d.store.setThreadQuiet(thread.id, false);
    }

    const parentName = thread.parent?.name ?? 'channel';
    this.d.runs.enqueue({
      ...this.baseItem(m, mentioned ? 'mention' : 'thread', ch.bundle, { id: parentId, name: parentName }),
      key: thread.id,
      contextLines,
      getChannel: async () => thread as unknown as SendableChannels,
      fetchHistory: async (limit) => {
        const parent = thread.parent;
        return parent && parent.isTextBased() ? fetchLines(parent, limit) : fetchLines(thread as unknown as TextBasedChannel, limit);
      },
    });
  }

  // ---- channels ---------------------------------------------------------------

  private async onChannelMessage(m: Message) {
    const mentioned = this.isMentioned(m);
    const ch = this.d.store.getChannel(m.channel.id);
    const chain = ch ? this.replyChain(m) : undefined;
    if (!mentioned && !chain) {
      if (ch?.reply_mode === 'ambient') await this.considerAmbient(m, ch);
      return;
    }
    if (!ch) {
      await this.deny(m, NOT_ENABLED);
      return;
    }
    if (chain?.quiet && !mentioned) return;
    const bundle = this.d.bundles.get(ch.bundle);
    if (!bundle) {
      await this.deny(m, `My access bundle "${ch.bundle}" is missing. An admin can run \`/zclaude enable\` again.`);
      return;
    }
    if (!hasAnyRole(m.member, bundle.allowedRoleIds)) {
      await this.deny(m, "You don't have a role that can hand me work in this channel.");
      return;
    }

    if (chain) {
      // A Discord reply to one of Claude's inline messages: same session, already has the history.
      if (chain.quiet) this.d.store.setThreadQuiet(chain.thread_id, false);
      this.registerAndEnqueue(m, ch, mentioned ? 'mention' : 'thread', chain.thread_id, async () => m.channel as SendableChannels, [], true);
      return;
    }
    const contextLines = await fetchLines(m.channel as TextBasedChannel, this.d.cfg.CONTEXT_MESSAGES, m.id).catch(() => []);
    if (!ch.threads) {
      this.registerAndEnqueue(m, ch, 'mention', m.id, async () => m.channel as SendableChannels, contextLines, true);
      return;
    }
    const { key, getChannel } = await this.openThread(m, true);
    this.registerAndEnqueue(m, ch, 'mention', key, getChannel, contextLines);
  }

  /** The inline conversation this message continues, when it's a Discord reply to one of Claude's messages here. */
  private replyChain(m: Message): ThreadRow | undefined {
    const ref = m.reference;
    if (!ref?.messageId || ref.type !== MessageReferenceType.Default || ref.channelId !== m.channelId) return undefined;
    return this.d.store.conversationFor(ref.messageId);
  }

  /**
   * Creates (or lazily creates) a thread on the message. Threads started from a message
   * share its id, so the key is stable before the thread exists. Channels that can't
   * hold threads get replies inline.
   */
  private async openThread(m: Message, eager: boolean): Promise<{ key: string; getChannel: () => Promise<SendableChannels> }> {
    const canThread = m.channel.type === ChannelType.GuildText || m.channel.type === ChannelType.GuildAnnouncement;
    if (!canThread) {
      // e.g. a voice channel's text chat: one rolling conversation per channel.
      const channel = m.channel as SendableChannels;
      return { key: m.channel.id, getChannel: async () => channel };
    }
    let thread: ThreadChannel | null = null;
    const create = async (): Promise<SendableChannels> => {
      if (thread) return thread as unknown as SendableChannels;
      try {
        thread = await m.startThread({ name: threadTitle(m.content), autoArchiveDuration: 1440 });
        return thread as unknown as SendableChannels;
      } catch (e) {
        // 160004: someone already opened a thread on this message; use it (same id as the message).
        const existing = await (m.channel as TextChannel).threads.fetch(m.id).catch(() => null);
        if (existing) {
          thread = existing;
          return thread as unknown as SendableChannels;
        }
        log.warn('could not create thread; replying inline', { error: errMsg(e) });
        return m.channel as SendableChannels;
      }
    };
    if (eager) await create();
    return { key: m.id, getChannel: create };
  }

  private registerAndEnqueue(
    m: Message,
    ch: ChannelRow,
    trigger: Trigger,
    key: string,
    getChannel: () => Promise<SendableChannels>,
    contextLines: string[],
    inline = false,
  ) {
    this.d.store.createThread({
      thread_id: key,
      parent_channel_id: ch.channel_id,
      guild_id: m.guild!.id,
      cwd: workspaceFor(this.d.cfg, m.guild!.id, ch.channel_id, key),
      bundle: ch.bundle,
    });
    const channelName = 'name' in m.channel ? (m.channel.name ?? 'channel') : 'channel';
    this.d.runs.enqueue({
      ...this.baseItem(m, trigger, ch.bundle, { id: ch.channel_id, name: channelName }),
      key,
      contextLines,
      getChannel,
      inline,
      fetchHistory: (limit) => fetchLines(m.channel as TextBasedChannel, limit),
    });
  }

  // ---- ambient ------------------------------------------------------------------

  private async considerAmbient(m: Message, ch: ChannelRow) {
    const cfg = this.d.bundles.ambient;
    const content = m.content.trim();
    if (content.length < cfg.minMessageLength) return;
    // Addressed to someone else, or a reply to another person: stay out.
    if (m.mentions.users.some((u) => u.id !== this.botId) || m.mentions.everyone) return;
    if (m.reference?.messageId) {
      const ref = await m.fetchReference().catch(() => null);
      if (ref && ref.author.id !== this.botId) return;
    }

    const now = Date.now();
    if (this.ambientInflight.has(ch.channel_id)) return;
    if (now - (this.lastAmbientCheck.get(ch.channel_id) ?? 0) < 20_000) return;
    if (this.d.store.ambientCount(ch.channel_id, now - 3600_000) >= cfg.maxPerHour) return;

    const bundle = this.d.bundles.get(ch.bundle);
    if (!bundle || !hasAnyRole(m.member, bundle.allowedRoleIds)) return;

    this.lastAmbientCheck.set(ch.channel_id, now);
    this.ambientInflight.add(ch.channel_id);
    try {
      const history = await fetchLines(m.channel as TextBasedChannel, cfg.contextMessages, m.id).catch(() => []);
      const memories = [
        ...this.d.store.listMemories('guild', m.guild!.id),
        ...this.d.store.listMemories('channel', ch.channel_id),
      ].map((r) => r.content);
      const decision = await shouldJumpIn({
        auth: this.d.auth,
        model: this.d.cfg.AMBIENT_MODEL,
        agentHome: this.d.cfg.agentHome,
        cwd: this.d.cfg.agentHome,
        history,
        latest: `${m.member?.displayName ?? m.author.username}: ${m.cleanContent}`,
        memories,
        botName: botName(this.d.client),
      });
      log.debug('ambient decision', { channel: ch.channel_id, ...decision });
      if (!decision.reply) return;
      if (!ch.threads) {
        this.registerAndEnqueue(m, ch, 'ambient', m.id, async () => m.channel as SendableChannels, history, true);
        return;
      }
      const { key, getChannel } = await this.openThread(m, false);
      this.registerAndEnqueue(m, ch, 'ambient', key, getChannel, history);
    } finally {
      this.ambientInflight.delete(ch.channel_id);
    }
  }
}
