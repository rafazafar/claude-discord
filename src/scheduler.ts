import { Cron } from 'croner';
import { ChannelType, type Client, type SendableChannels, type TextChannel } from 'discord.js';
import type { Store, ScheduleRow } from './db.js';
import type { Config } from './config.js';
import type { RunManager } from './discord/runs.js';
import { fetchLines, workspaceFor } from './discord/util.js';
import { threadTitle } from './format.js';
import { log, errMsg } from './log.js';

/**
 * Runs standing work on cron schedules. Each run posts a starter message in the
 * channel, opens a thread on it, and works there with a fresh session.
 */
export class Scheduler {
  private jobs = new Map<number, { cron: Cron; sig: string }>();

  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly runs: () => RunManager,
  ) {}

  /** Syncs cron jobs with the schedules table. Safe to call often. */
  reload(): void {
    const rows = this.store.listSchedules({ enabledOnly: true });
    const seen = new Set<number>();
    for (const row of rows) {
      seen.add(row.id);
      const sig = `${row.cron}|${row.tz}`;
      const existing = this.jobs.get(row.id);
      if (existing && existing.sig === sig) continue;
      existing?.cron.stop();
      try {
        const cron = new Cron(row.cron, { timezone: row.tz, protect: true }, () => {
          void this.fire(row.id);
        });
        this.jobs.set(row.id, { cron, sig });
      } catch (e) {
        log.error('invalid schedule; skipping', { id: row.id, error: errMsg(e) });
      }
    }
    for (const [id, job] of this.jobs) {
      if (!seen.has(id)) {
        job.cron.stop();
        this.jobs.delete(id);
      }
    }
    log.info('schedules loaded', { count: this.jobs.size });
  }

  stop(): void {
    for (const job of this.jobs.values()) job.cron.stop();
    this.jobs.clear();
  }

  nextRun(id: number): Date | null {
    return this.jobs.get(id)?.cron.nextRun() ?? null;
  }

  /** Runs a schedule now (also used by /claude schedule run). */
  async fire(id: number): Promise<void> {
    const row = this.store.getSchedule(id);
    if (!row || !row.enabled) return;
    const ch = this.store.getChannel(row.channel_id);
    if (!ch) {
      log.warn('schedule channel no longer enabled; skipping', { id });
      return;
    }
    this.store.markScheduleRun(id, Date.now());
    try {
      await this.start(row, ch.bundle, !!ch.threads);
    } catch (e) {
      log.error('scheduled run failed to start', { id, error: errMsg(e) });
    }
  }

  private async start(row: ScheduleRow, bundleName: string, threads: boolean) {
    const channel = await this.client.channels.fetch(row.channel_id);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      log.warn('schedule channel missing or unsupported', { id: row.id });
      return;
    }
    const text = channel as TextChannel;
    const starter = await text.send({
      content: `🗓️ **Scheduled:** ${row.description || threadTitle(row.prompt)} · schedule #${row.id}`,
      allowedMentions: { parse: [] },
    });
    // Without threads the run replies to the starter, and replying to it continues the conversation.
    const thread = threads ? await starter.startThread({ name: threadTitle(row.description || row.prompt), autoArchiveDuration: 1440 }) : null;
    const key = thread?.id ?? starter.id;
    this.store.createThread({
      thread_id: key,
      parent_channel_id: row.channel_id,
      guild_id: row.guild_id,
      cwd: workspaceFor(this.cfg, row.guild_id, row.channel_id, key),
      bundle: bundleName,
    });
    if (!thread) this.store.linkMessage(starter.id, key);
    let userName = 'scheduler';
    try {
      const u = await this.client.users.fetch(row.created_by);
      userName = `${u.displayName ?? u.username} (via schedule)`;
    } catch {
      /* keep default */
    }
    this.runs().enqueue({
      key,
      trigger: 'schedule',
      guildId: row.guild_id,
      guildName: text.guild.name,
      configChannelId: row.channel_id,
      configChannelName: text.name,
      bundleName,
      userId: row.created_by,
      userName,
      isAdmin: false,
      content: row.prompt,
      attachments: [],
      contextLines: [],
      getChannel: async () => (thread ?? text) as SendableChannels,
      inline: !thread,
      sourceMessage: starter,
      fetchHistory: (limit) => fetchLines(text, limit),
    });
  }
}
