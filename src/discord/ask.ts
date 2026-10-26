import {
  ActionRowBuilder,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Message,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type SendableChannels,
  type TextBasedChannel,
} from 'discord.js';
import type { Store } from '../db.js';
import type { BundleRegistry } from '../bundles.js';
import type { Config } from '../config.js';
import type { PrivateReply, RunManager } from './runs.js';
import { fetchLines, fetchMessages, formatMessageLine, hasAnyRole, isAdmin, workspaceFor } from './util.js';
import { log, errMsg } from '../log.js';
import { botName } from '../botname.js';
import { MODEL_ALIASES } from '../flags.js';
import type { Effort } from '../bundles.js';

/**
 * Private questions: /claude ask and the "Ask Claude privately" and "Translate from here"
 * message menu entries.
 * Discord shows the command, the prompt and the answer only to the asker. Each person
 * gets one private session per channel, so follow-up questions keep their context.
 */

/** "Ask zClaude privately": named after the bot, as registered at startup. */
export function askMenuName(bot: string): string {
  return `Ask ${bot} privately`;
}
export const TRANSLATE_MENU = 'Translate from here';
/** The question "Translate from here" asks; the asker's Discord language decides the target. */
export const TRANSLATE_PROMPT =
  "Translate the conversation from the message I selected up to now into my language. Start with a one-line gist. Then give the translation, merging consecutive messages from the same person into one line with their name. End with short notes on tone, politeness or implied meaning, only where it changes what was meant. Skip messages already in my language unless they're needed to follow along.";
const MODAL_PREFIX = 'claude-ask:';
const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
/** Discord lets a bot edit an interaction's replies for 15 minutes; after that the answer goes by DM. */
const INTERACTION_WINDOW_MS = 13 * 60_000;
/** How much of the conversation from the selected message onwards Claude reads. */
const MAX_FROM_ANCHOR = 100;
const BEFORE_ANCHOR = 10;

export function askMenuCommand(bot: string) {
  return new ContextMenuCommandBuilder()
    .setName(askMenuName(bot))
    .setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild);
}

export const translateMenuCommand = new ContextMenuCommandBuilder()
  .setName(TRANSLATE_MENU)
  .setType(ApplicationCommandType.Message)
  .setContexts(InteractionContextType.Guild);

export function askKey(channelId: string, userId: string): string {
  return `ask-${channelId}-${userId}`;
}

export interface AskDeps {
  client: Client;
  store: Store;
  bundles: BundleRegistry;
  cfg: Config;
  runs: RunManager;
}

type AskInteraction = ChatInputCommandInteraction | ModalSubmitInteraction | MessageContextMenuCommandInteraction;

export class AskHandler {
  /** Newest channel message each private session has already seen, so follow-ups only add what's new. */
  private readonly seen = new Map<string, string>();

  constructor(private readonly d: AskDeps) {}

  async slash(i: ChatInputCommandInteraction) {
    const model = i.options.getString('model');
    await this.run(i, i.options.getString('prompt', true), {
      fresh: i.options.getBoolean('new') ?? false,
      model: model ? MODEL_ALIASES[model] : undefined,
      effort: (i.options.getString('effort') as Effort | null) ?? undefined,
    });
  }

  /**
   * Right-click a message → Apps. "Translate from here" answers straight away; "Ask Claude
   * privately" first asks what you want to know. Both read the conversation from that message on,
   * in the same private session as /claude ask, so a follow-up ask continues from the answer.
   */
  async menu(i: MessageContextMenuCommandInteraction) {
    if (i.commandName === TRANSLATE_MENU) {
      await this.run(i, TRANSLATE_PROMPT, { fresh: false, anchorId: i.targetId });
      return;
    }
    const input = new TextInputBuilder()
      .setCustomId('prompt')
      .setLabel('What do you want to know?')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('e.g. What are they saying from here on? Translate it and explain the tone.')
      .setRequired(true)
      .setMaxLength(4000);
    await i.showModal(
      new ModalBuilder()
        .setCustomId(MODAL_PREFIX + i.targetId)
        .setTitle(askMenuName(botName(this.d.client)).slice(0, 45))
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
    );
  }

  isModal(customId: string): boolean {
    return customId.startsWith(MODAL_PREFIX);
  }

  async modal(i: ModalSubmitInteraction) {
    await this.run(i, i.fields.getTextInputValue('prompt'), { fresh: false, anchorId: i.customId.slice(MODAL_PREFIX.length) });
  }

  private async run(i: AskInteraction, prompt: string, opts: { fresh: boolean; anchorId?: string; model?: string; effort?: Effort }) {
    const { store, bundles, cfg, runs } = this.d;
    const channel = i.channel;
    if (!i.inGuild() || !i.guild || !channel?.isTextBased()) {
      await i.reply({ content: 'Use this in a server channel.', ...EPHEMERAL });
      return;
    }
    const configChannelId = channel.isThread() ? channel.parentId : channel.id;
    const ch = configChannelId ? store.getChannel(configChannelId) : undefined;
    const bundle = ch ? bundles.get(ch.bundle) : undefined;
    if (!ch || !bundle) {
      await i.reply({ content: `${botName(this.d.client)} isn't set up in this channel. An admin can run \`/claude enable\` here.`, ...EPHEMERAL });
      return;
    }
    const admin = isAdmin(cfg, i.user.id, i.member);
    if (!admin && !hasAnyRole(i.member, bundle.allowedRoleIds)) {
      await i.reply({ content: `You don't have a role that can use ${botName(this.d.client)} in this channel.`, ...EPHEMERAL });
      return;
    }
    const key = askKey(channel.id, i.user.id);
    if (runs.isBusy(key)) {
      await i.reply({ content: "I'm still answering your last question here. Wait for it, or stop it with `/claude stop`.", ...EPHEMERAL });
      return;
    }
    await i.deferReply(EPHEMERAL);

    const row = store.createThread({
      thread_id: key,
      parent_channel_id: ch.channel_id,
      guild_id: i.guild.id,
      cwd: workspaceFor(cfg, i.guild.id, ch.channel_id, key),
      bundle: ch.bundle,
    });
    const fresh = opts.fresh || !row.session_id;
    if (opts.fresh) store.clearThreadSession(key);

    const contextLines = await this.context(channel, key, fresh, opts.anchorId).catch((e) => {
      log.warn('ask: could not read channel history', { error: errMsg(e) });
      return [] as string[];
    });

    const member = i.member as GuildMember | null;
    const parentName = (channel.isThread() ? channel.parent?.name : 'name' in channel ? channel.name : null) ?? 'channel';
    runs.enqueue({
      key,
      trigger: 'private',
      guildId: i.guild.id,
      guildName: i.guild.name,
      configChannelId: ch.channel_id,
      configChannelName: parentName,
      bundleName: ch.bundle,
      userId: i.user.id,
      userName: member?.displayName ?? i.user.displayName ?? i.user.username,
      isAdmin: admin,
      content: prompt,
      attachments: [],
      contextLines,
      getChannel: async () => channel as SendableChannels,
      fetchHistory: (limit) => fetchLines(channel, limit),
      privateReply: privateReplier(i),
      locale: i.locale,
      modelOverride: opts.model,
      effortOverride: opts.effort,
    });
  }

  /**
   * What Claude reads with the question. From a selected message: that message and everything
   * after it, with a few earlier ones for context. Otherwise: recent messages, or on a follow-up
   * only the ones posted since the last question (the session already has the rest).
   */
  private async context(channel: TextBasedChannel, key: string, fresh: boolean, anchorId?: string): Promise<string[]> {
    const lastSeen = fresh ? undefined : this.seen.get(key);
    const recent = await fetchMessages(channel, MAX_FROM_ANCHOR);
    const newest = recent[recent.length - 1];
    if (newest) this.seen.set(key, newest.id);

    if (anchorId) {
      const at = recent.findIndex((m) => m.id === anchorId);
      if (at === -1) {
        const anchor = await channel.messages.fetch(anchorId).catch(() => null);
        return [
          ...(anchor ? [`(they selected this message) ${formatMessageLine(anchor)}`] : []),
          `(the conversation since then is long; these are the latest ${recent.length} messages)`,
          ...recent.map(formatMessageLine),
        ];
      }
      return [
        ...recent.slice(Math.max(0, at - BEFORE_ANCHOR), at).map(formatMessageLine),
        '(they selected the next message: explain from here on)',
        ...recent.slice(at).map(formatMessageLine),
      ];
    }

    const pick: Message[] = lastSeen
      ? recent.filter((m) => BigInt(m.id) > BigInt(lastSeen))
      : recent.slice(-this.d.cfg.CONTEXT_MESSAGES);
    if (lastSeen && !pick.length) return [];
    return lastSeen ? ['(new since their last question)', ...pick.map(formatMessageLine)] : pick.map(formatMessageLine);
  }
}

/**
 * Sends the answer as private replies to the interaction. Past Discord's 15-minute window
 * the interaction can't be updated, so a long run says so and finishes by DM.
 */
function privateReplier(i: AskInteraction): PrivateReply {
  let answered = false;
  let viaDm = false;
  const timer = setTimeout(() => {
    if (answered) return;
    viaDm = true;
    i.editReply({ content: "⏳ This is taking a while. I'll send the answer by DM." }).catch(() => {});
  }, INTERACTION_WINDOW_MS);
  timer.unref();

  return async (payload) => {
    const body = { content: payload.content, files: payload.files, allowedMentions: { parse: [] } };
    if (viaDm) {
      await i.user.send(body).catch((e) => log.warn('ask: could not DM the answer', { error: errMsg(e) }));
      return;
    }
    if (!answered) {
      answered = true;
      clearTimeout(timer);
      await i.editReply(body);
    } else {
      await i.followUp({ ...body, ...EPHEMERAL });
    }
  };
}
