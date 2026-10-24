import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type MessageCreateOptions,
  type SendableChannels,
} from 'discord.js';
import type { Store } from '../db.js';
import type { BundleRegistry } from '../bundles.js';
import type { AuthManager } from '../auth.js';
import type { Config } from '../config.js';
import { Semaphore } from '../semaphore.js';
import { runAgent, type RunResult } from '../agent.js';
import { describeTool, formatDuration, splitMessage, tablesToCodeBlocks, truncate } from '../format.js';
import { log, errMsg } from '../log.js';
import { ensureAgentDir, giveToAgent } from '../sandbox.js';

export type Trigger = 'mention' | 'thread' | 'dm' | 'ambient' | 'schedule';

export interface WorkAttachment {
  name: string;
  url: string;
  size: number;
}

export interface WorkItem {
  /** Thread id (or DM channel id): the conversation key that owns the session. */
  key: string;
  trigger: Trigger;
  guildId: string | null;
  guildName: string | null;
  /** Channel whose config and memory apply (parent channel for threads). */
  configChannelId: string;
  configChannelName: string;
  bundleName: string;
  userId: string;
  userName: string;
  /** Requester is a server admin (gates admin-only Discord tools). */
  isAdmin: boolean;
  content: string;
  attachments: WorkAttachment[];
  /** Earlier conversation shown as context (channel or thread history). */
  contextLines: string[];
  /** Where replies go. For ambient work this creates the thread lazily, only if Claude replies. */
  getChannel: () => Promise<SendableChannels>;
  /**
   * No thread: Claude answers in the channel as a Discord reply to `sourceMessage`, and every
   * message it posts is linked so replying to it continues this conversation.
   */
  inline?: boolean;
  sourceMessage?: Message;
  fetchHistory: (limit: number) => Promise<string[]>;
}

/** Stops message text from closing or opening the prompt's own tags. */
export function escapeTags(s: string): string {
  return s.replace(/<(\/?)(message|context)\b/gi, '‹$1$2');
}

export const STOP_PREFIX = 'claude-stop:';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const NO_REPLY = 'NO_REPLY';

interface ActiveRun {
  abort: AbortController;
  startedBy: string;
  channelId: string;
}

type Send = (payload: MessageCreateOptions) => Promise<Message>;

export interface RunManagerDeps {
  store: Store;
  bundles: BundleRegistry;
  auth: AuthManager;
  cfg: Config;
  onSchedulesChanged: () => void;
}

/** Live progress message with a Stop button, edited at most every ~2s. */
class StatusReporter {
  private msg: Message | null = null;
  private steps: string[] = [];
  private count = 0;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private header = '⏳ Working on it…';
  private finished = false;
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly send: Send,
    private readonly key: string,
  ) {}

  private render(): string {
    const recent = this.steps.slice(-6).map((s) => `> ${s}`);
    const more = this.count > 6 ? [`> …and ${this.count - 6} earlier steps`] : [];
    return [this.header, ...more, ...recent].join('\n').slice(0, 1990);
  }

  private stopRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(STOP_PREFIX + this.key).setLabel('Stop').setStyle(ButtonStyle.Secondary),
    );
  }

  async start(header?: string) {
    if (header) this.header = header;
    try {
      this.msg = await this.send({ content: this.render(), components: [this.stopRow()] });
    } catch (e) {
      log.warn('status send failed', { error: errMsg(e) });
    }
  }

  setHeader(h: string) {
    this.header = h;
    this.schedule();
  }

  step(s: string) {
    this.count++;
    this.steps.push(s);
    this.schedule();
  }

  private schedule() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty && !this.finished) this.inflight = this.flush();
    }, 2000);
  }

  private async flush() {
    this.dirty = false;
    if (!this.msg || this.finished) return;
    try {
      await this.msg.edit({ content: this.render(), components: [this.stopRow()] });
    } catch (e) {
      log.debug('status edit failed', { error: errMsg(e) });
    }
  }

  async finish(line: string) {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inflight.catch(() => {}); // never let a late progress edit overwrite the final line
    if (!this.msg) return;
    try {
      await this.msg.edit({ content: line, components: [] });
    } catch (e) {
      log.debug('status finish failed', { error: errMsg(e) });
    }
  }

  get stepCount() {
    return this.count;
  }
}

export class RunManager {
  private readonly sem: Semaphore;
  private readonly queues = new Map<string, WorkItem[]>();
  private readonly processing = new Set<string>();
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly deps: RunManagerDeps) {
    this.sem = new Semaphore(deps.cfg.MAX_CONCURRENT_RUNS);
  }

  isBusy(key: string): boolean {
    return this.processing.has(key);
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** Queues work for a conversation. Messages that arrive mid-run are batched into the next turn. */
  enqueue(item: WorkItem): void {
    const q = this.queues.get(item.key) ?? [];
    q.push(item);
    this.queues.set(item.key, q);
    if (this.processing.has(item.key)) {
      item.sourceMessage?.react('📥').catch(() => {});
      return;
    }
    void this.drain(item.key);
  }

  stop(key: string): boolean {
    const run = this.active.get(key);
    if (!run) return false;
    run.abort.abort();
    return true;
  }

  /** Stops every run in a channel (inline conversations have no thread of their own to stop from). */
  stopChannel(channelId: string): number {
    let n = 0;
    for (const run of this.active.values()) {
      if (run.channelId !== channelId) continue;
      run.abort.abort();
      n++;
    }
    return n;
  }

  stopAll(): void {
    for (const run of this.active.values()) run.abort.abort();
  }

  private async drain(key: string) {
    this.processing.add(key);
    try {
      while (true) {
        const items = this.queues.get(key);
        if (!items?.length) break;
        this.queues.set(key, []);
        try {
          await this.runBatch(items);
        } catch (e) {
          log.error('run failed', { key, error: errMsg(e) });
          try {
            const ch = await items[0]!.getChannel();
            await ch.send(`⚠️ Something went wrong: ${truncate(errMsg(e), 300)}`);
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      this.processing.delete(key);
      this.queues.delete(key);
    }
  }

  private async downloadAttachments(items: WorkItem[], cwd: string): Promise<string[]> {
    const saved: string[] = [];
    const dir = path.join(cwd, 'attachments');
    for (const item of items) {
      for (const a of item.attachments) {
        if (a.size > MAX_ATTACHMENT_BYTES) {
          saved.push(`(skipped ${a.name}: larger than 25 MB)`);
          continue;
        }
        try {
          ensureAgentDir(dir);
          const safe = a.name.replace(/[^\w.\-]+/g, '_').slice(-120) || 'file';
          let target = path.join(dir, safe);
          for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${n}-${safe}`);
          const res = await fetch(a.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
          giveToAgent(target);
          saved.push(path.relative(cwd, target));
        } catch (e) {
          saved.push(`(failed to download ${a.name}: ${errMsg(e)})`);
        }
      }
    }
    return saved;
  }

  buildPrompt(items: WorkItem[], files: string[]): string {
    const first = items[0]!;
    const { store, cfg } = this.deps;
    const channelMem = store.listMemories('channel', first.configChannelId);
    const guildMem = first.guildId ? store.listMemories('guild', first.guildId) : [];
    const now = new Date();

    const ctx: string[] = [
      `Current time: ${now.toISOString()} (bot timezone ${cfg.DEFAULT_TIMEZONE})`,
      `Requested by: ${[...new Set(items.map((i) => `${i.userName} (<@${i.userId}>)`))].join(', ')}`,
    ];
    if (guildMem.length) ctx.push('Server memory:', ...guildMem.map((m) => `- #${m.id} ${m.content}`));
    if (channelMem.length) ctx.push('Channel memory:', ...channelMem.map((m) => `- #${m.id} ${m.content}`));
    if (files.length) ctx.push('Attachments saved in your working directory:', ...files.map((f) => `- ${f}`));
    if (first.contextLines.length) ctx.push('Earlier conversation (oldest first):', ...first.contextLines.map(escapeTags));

    if (first.trigger === 'ambient') {
      ctx.push(
        '',
        'Nobody tagged you: you are considering jumping in unprompted because the latest message looks like something you can help with.',
        `Reply briefly and only if you add clear value. If on reflection you shouldn't reply, respond with exactly ${NO_REPLY}.`,
      );
    }
    if (first.trigger === 'schedule') {
      ctx.push('', 'This is a scheduled run of standing work. Post the result as your final message.');
    }

    const msgs = items
      .map((i) => `<message from="${i.userName.replace(/"/g, "'")}">\n${escapeTags(i.content) || '(no text)'}\n</message>`)
      .join('\n');
    return `<context>\n${ctx.join('\n')}\n</context>\n\n${msgs}`;
  }

  private async runBatch(items: WorkItem[]) {
    const { store, bundles, auth, cfg } = this.deps;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    let thread = store.getThread(first.key);
    if (!thread) throw new Error('conversation not registered');
    const bundle = bundles.get(first.bundleName);
    if (!bundle) {
      const ch = await first.getChannel();
      await ch.send(`⚠️ Access bundle "${first.bundleName}" no longer exists. An admin can fix this with \`/claude enable\`.`);
      return;
    }
    // The system prompt is recorded per session; if the channel's bundle changed, start fresh
    // so Claude's description of its own access matches the tools it actually has.
    if (thread.bundle !== first.bundleName) {
      store.setThreadBundle(first.key, first.bundleName);
      thread = store.getThread(first.key)!;
    }

    const lazy = first.trigger === 'ambient';
    const files = await this.downloadAttachments(items, thread.cwd);
    const prompt = this.buildPrompt(items, files);

    let status: StatusReporter | null = null;
    let channel: SendableChannels | null = null;
    const getChannel = async () => (channel ??= await first.getChannel());
    const replyTo = first.inline ? last.sourceMessage : undefined;
    const send = async (payload: MessageCreateOptions, asReply = false): Promise<Message> => {
      const ch = await getChannel();
      const msg = await ch.send(asReply && replyTo ? { ...payload, reply: { messageReference: replyTo, failIfNotExists: false } } : payload);
      if (first.inline) store.linkMessage(msg.id, first.key);
      return msg;
    };

    // Register before queueing for a slot so Stop works while queued.
    const abort = new AbortController();
    this.active.set(first.key, { abort, startedBy: last.userId, channelId: first.configChannelId });

    if (!lazy) {
      status = new StatusReporter((p) => send(p, true), first.key);
      await status.start(this.sem.inUse >= cfg.MAX_CONCURRENT_RUNS ? '⏳ Queued behind other work…' : undefined);
    }

    const release = await this.sem.acquire();
    if (abort.signal.aborted) {
      release();
      this.active.delete(first.key);
      await status?.finish('⏹️ Stopped before it started.');
      return;
    }
    status?.setHeader('⏳ Working on it…');
    const started = Date.now();
    const prevSession = thread.session_id;
    const prevCost = thread.session_cost;
    let runId: number | null = null;
    let result: RunResult;

    try {
      runId = store.startRun({
        threadId: first.key,
        channelId: first.configChannelId,
        guildId: first.guildId,
        userId: last.userId,
        trigger: first.trigger,
      });
      result = await runAgent(
        { bundles, auth, agentHome: cfg.agentHome, pluginDir: cfg.pluginDir },
        {
          prompt,
          bundle,
          sessionId: thread.session_id,
          cwd: thread.cwd,
          model: bundle.model ?? cfg.CLAUDE_MODEL,
          context: {
            guildName: first.guildName,
            channelName: first.configChannelName,
            isDM: !first.guildId,
            bundleName: first.bundleName,
          },
          abort,
          toolCtx: {
            store,
            guildId: first.guildId,
            channelId: first.configChannelId,
            threadId: first.key,
            userId: last.userId,
            isAdmin: items.every((i) => i.isAdmin),
            workspace: thread.cwd,
            defaultTimezone: cfg.DEFAULT_TIMEZONE,
            sendFile: async (abs, caption) => {
              await send({ content: caption ?? undefined, files: [new AttachmentBuilder(abs)] });
            },
            fetchHistory: first.fetchHistory,
            onSchedulesChanged: this.deps.onSchedulesChanged,
            onQuietThread: () => {},
          },
          onToolUse: (name, input) => status?.step(describeTool(name, input)),
          onSession: (sid) => store.setThreadSession(first.key, sid),
        },
      );
    } catch (e) {
      result = { status: 'error', text: '', sessionId: null, costUsd: 0, turns: 0, error: errMsg(e) };
    } finally {
      release();
      this.active.delete(first.key);
    }

    // total_cost_usd is cumulative for a resumed session; record only this run's share.
    const runCost =
      result.sessionId && result.sessionId === prevSession ? Math.max(0, result.costUsd - prevCost) : result.costUsd;
    if (runId !== null) store.finishRun(runId, result.status, runCost, result.turns);
    if (result.sessionId) store.setThreadSession(first.key, result.sessionId, result.costUsd);
    else store.touchThread(first.key);
    result.costUsd = runCost;

    const elapsed = formatDuration(Date.now() - started);
    const steps = status?.stepCount ?? 0;
    const cost = auth.mode() === 'api_key' && result.costUsd > 0 ? ` · ~$${result.costUsd.toFixed(2)}` : '';
    log.info('run finished', { key: first.key, status: result.status, turns: result.turns, cost: result.costUsd, elapsed });

    if (lazy) {
      const body = result.text.trim();
      if (result.status !== 'success' || !body || body === NO_REPLY || body.endsWith(NO_REPLY)) {
        // Claude stayed out: forget this conversation so a human thread on the message isn't adopted.
        store.deleteThread(first.key);
        return;
      }
      store.logAmbient(first.configChannelId);
      await this.postText(send, body);
      return;
    }

    const footer = `· ${elapsed} · ${steps} step${steps === 1 ? '' : 's'}${cost}`;
    switch (result.status) {
      case 'success':
        await status?.finish(`✅ Done ${footer}`);
        break;
      case 'aborted':
        await status?.finish(`⏹️ Stopped ${footer}`);
        break;
      case 'max_turns':
        await status?.finish(`⚠️ Hit the step limit (${bundle.maxTurns}) ${footer}. Reply "continue" to keep going.`);
        break;
      case 'budget':
        await status?.finish(`⚠️ Hit this channel's per-task budget ($${bundle.maxBudgetUsd}) ${footer}. Reply "continue" to keep going.`);
        break;
      default:
        await status?.finish(`⚠️ ${truncate(result.error ?? 'Something went wrong.', 1800)} ${footer}`);
    }
    // On errors the text is usually the raw error, already summarised in the status line.
    if (result.status !== 'error' && result.text.trim()) await this.postText(send, result.text);
  }

  /** Posts the answer; inline, its first chunk is a reply so it's clear what it answers. */
  private async postText(send: (payload: MessageCreateOptions, asReply?: boolean) => Promise<Message>, text: string) {
    let first = true;
    for (const chunk of splitMessage(tablesToCodeBlocks(text))) {
      await send({ content: chunk, allowedMentions: { parse: ['users'] } }, first);
      first = false;
    }
  }
}
