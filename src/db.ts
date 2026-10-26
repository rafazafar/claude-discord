import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Effort } from './bundles.js';

export type ReplyMode = 'mention' | 'ambient';
export type MemoryScope = 'channel' | 'guild';

export interface ChannelRow {
  channel_id: string;
  guild_id: string;
  bundle: string;
  reply_mode: ReplyMode;
  /** 1: each tag opens a thread. 0: Claude replies inline and Discord replies continue the conversation. */
  threads: number;
  /** Overrides the bundle's effort in this channel; null uses the bundle's. */
  effort: Effort | null;
  /** Overrides the bundle's model in this channel; null uses the bundle's. */
  model: string | null;
  updated_by: string | null;
  updated_at: number;
}

export interface ThreadRow {
  thread_id: string;
  parent_channel_id: string;
  guild_id: string | null;
  session_id: string | null;
  cwd: string;
  bundle: string;
  quiet: number;
  session_cost: number;
  created_at: number;
  last_active: number;
}

export interface MemoryRow {
  id: number;
  scope: MemoryScope;
  scope_id: string;
  content: string;
  created_by: string | null;
  created_at: number;
}

export interface ScheduleRow {
  id: number;
  guild_id: string | null;
  channel_id: string;
  cron: string;
  tz: string;
  prompt: string;
  description: string;
  created_by: string;
  enabled: number;
  last_run_at: number | null;
  created_at: number;
}

export interface RunRow {
  id: number;
  thread_id: string;
  channel_id: string;
  guild_id: string | null;
  user_id: string;
  trigger: string;
  status: string;
  cost_usd: number;
  turns: number;
  started_at: number;
  ended_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  bundle     TEXT NOT NULL,
  reply_mode TEXT NOT NULL DEFAULT 'mention',
  threads    INTEGER NOT NULL DEFAULT 0,
  effort     TEXT,
  model      TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  thread_id         TEXT PRIMARY KEY,
  parent_channel_id TEXT NOT NULL,
  guild_id          TEXT,
  session_id        TEXT,
  cwd               TEXT NOT NULL,
  bundle            TEXT NOT NULL,
  quiet             INTEGER NOT NULL DEFAULT 0,
  session_cost      REAL NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_active       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  scope_id   TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, scope_id);

CREATE TABLE IF NOT EXISTS schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT,
  channel_id  TEXT NOT NULL,
  cron        TEXT NOT NULL,
  tz          TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id   TEXT,
  user_id    TEXT NOT NULL,
  trigger    TEXT NOT NULL,
  status     TEXT NOT NULL,
  cost_usd   REAL NOT NULL DEFAULT 0,
  turns      INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX IF NOT EXISTS runs_guild_time ON runs(guild_id, started_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ambient_log (
  channel_id TEXT NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ambient_log_channel ON ambient_log(channel_id, at);

-- Claude's inline messages, so a Discord reply to one continues its conversation.
CREATE TABLE IF NOT EXISTS reply_links (
  message_id TEXT PRIMARY KEY,
  conv_key   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reply_links_time ON reply_links(created_at);
`;

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to old databases. */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('threads')) this.db.exec('ALTER TABLE channels ADD COLUMN threads INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('effort')) this.db.exec('ALTER TABLE channels ADD COLUMN effort TEXT');
    if (!cols.includes('model')) this.db.exec('ALTER TABLE channels ADD COLUMN model TEXT');
  }

  // ---- channels -------------------------------------------------------------

  getChannel(channelId: string): ChannelRow | undefined {
    return this.db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(channelId) as ChannelRow | undefined;
  }

  enableChannel(channelId: string, guildId: string, bundle: string, by: string): void {
    this.db
      .prepare(
        `INSERT INTO channels (channel_id, guild_id, bundle, reply_mode, updated_by, updated_at)
         VALUES (?, ?, ?, 'mention', ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET bundle = excluded.bundle, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(channelId, guildId, bundle, by, Date.now());
  }

  disableChannel(channelId: string): boolean {
    return this.db.prepare('DELETE FROM channels WHERE channel_id = ?').run(channelId).changes > 0;
  }

  setReplyMode(channelId: string, mode: ReplyMode, by: string): boolean {
    return (
      this.db
        .prepare('UPDATE channels SET reply_mode = ?, updated_by = ?, updated_at = ? WHERE channel_id = ?')
        .run(mode, by, Date.now(), channelId).changes > 0
    );
  }

  setThreads(channelId: string, on: boolean, by: string): boolean {
    return (
      this.db
        .prepare('UPDATE channels SET threads = ?, updated_by = ?, updated_at = ? WHERE channel_id = ?')
        .run(on ? 1 : 0, by, Date.now(), channelId).changes > 0
    );
  }

  setEffort(channelId: string, effort: Effort | null, by: string): boolean {
    return (
      this.db
        .prepare('UPDATE channels SET effort = ?, updated_by = ?, updated_at = ? WHERE channel_id = ?')
        .run(effort, by, Date.now(), channelId).changes > 0
    );
  }

  setModel(channelId: string, model: string | null, by: string): boolean {
    return (
      this.db
        .prepare('UPDATE channels SET model = ?, updated_by = ?, updated_at = ? WHERE channel_id = ?')
        .run(model, by, Date.now(), channelId).changes > 0
    );
  }

  listChannels(guildId: string): ChannelRow[] {
    return this.db.prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY updated_at DESC').all(guildId) as ChannelRow[];
  }

  // ---- threads --------------------------------------------------------------

  getThread(threadId: string): ThreadRow | undefined {
    return this.db.prepare('SELECT * FROM threads WHERE thread_id = ?').get(threadId) as ThreadRow | undefined;
  }

  createThread(t: Omit<ThreadRow, 'created_at' | 'last_active' | 'quiet' | 'session_id' | 'session_cost'>): ThreadRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO threads (thread_id, parent_channel_id, guild_id, session_id, cwd, bundle, quiet, created_at, last_active)
         VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?)
         ON CONFLICT(thread_id) DO NOTHING`,
      )
      .run(t.thread_id, t.parent_channel_id, t.guild_id, t.cwd, t.bundle, now, now);
    return this.getThread(t.thread_id)!;
  }

  /** Records the session id; `cost` (cumulative for the session) when known. */
  setThreadSession(threadId: string, sessionId: string, cost?: number): void {
    if (cost === undefined) {
      this.db
        .prepare('UPDATE threads SET session_id = ?, last_active = ? WHERE thread_id = ?')
        .run(sessionId, Date.now(), threadId);
    } else {
      this.db
        .prepare('UPDATE threads SET session_id = ?, session_cost = ?, last_active = ? WHERE thread_id = ?')
        .run(sessionId, cost, Date.now(), threadId);
    }
  }

  clearThreadSession(threadId: string): boolean {
    return this.db.prepare('UPDATE threads SET session_id = NULL, session_cost = 0 WHERE thread_id = ?').run(threadId).changes > 0;
  }

  setThreadBundle(threadId: string, bundle: string): void {
    this.db.prepare('UPDATE threads SET bundle = ?, session_id = NULL, session_cost = 0 WHERE thread_id = ?').run(bundle, threadId);
  }

  deleteThread(threadId: string): void {
    this.db.prepare('DELETE FROM threads WHERE thread_id = ?').run(threadId);
    this.db.prepare('DELETE FROM reply_links WHERE conv_key = ?').run(threadId);
  }

  setThreadQuiet(threadId: string, quiet: boolean): void {
    this.db.prepare('UPDATE threads SET quiet = ? WHERE thread_id = ?').run(quiet ? 1 : 0, threadId);
  }

  /** Conversations with no activity since `before`: candidates for workspace cleanup. */
  listInactiveThreads(before: number): ThreadRow[] {
    return this.db.prepare('SELECT * FROM threads WHERE last_active < ?').all(before) as ThreadRow[];
  }

  touchThread(threadId: string): void {
    this.db.prepare('UPDATE threads SET last_active = ? WHERE thread_id = ?').run(Date.now(), threadId);
  }

  // ---- inline reply chains -----------------------------------------------------

  linkMessage(messageId: string, convKey: string): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO reply_links (message_id, conv_key, created_at) VALUES (?, ?, ?) ON CONFLICT(message_id) DO NOTHING')
      .run(messageId, convKey, now);
    // keep the table small; replying to a month-old answer starts fresh
    this.db.prepare('DELETE FROM reply_links WHERE created_at < ?').run(now - 30 * 24 * 3600 * 1000);
  }

  /** The conversation a message of Claude's belongs to, if it was posted inline. */
  conversationFor(messageId: string): ThreadRow | undefined {
    return this.db
      .prepare('SELECT t.* FROM reply_links l JOIN threads t ON t.thread_id = l.conv_key WHERE l.message_id = ?')
      .get(messageId) as ThreadRow | undefined;
  }

  // ---- memories -------------------------------------------------------------

  addMemory(scope: MemoryScope, scopeId: string, content: string, by: string | null): MemoryRow {
    const info = this.db
      .prepare('INSERT INTO memories (scope, scope_id, content, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(scope, scopeId, content, by, Date.now());
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(info.lastInsertRowid) as MemoryRow;
  }

  listMemories(scope: MemoryScope, scopeId: string): MemoryRow[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE scope = ? AND scope_id = ? ORDER BY id')
      .all(scope, scopeId) as MemoryRow[];
  }

  /** Deletes a memory only if it belongs to one of the given scopes (so a channel can't delete another channel's memory). */
  deleteMemory(id: number, allowed: Array<{ scope: MemoryScope; scopeId: string }>): boolean {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) return false;
    if (!allowed.some((a) => a.scope === row.scope && a.scopeId === row.scope_id)) return false;
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  clearMemories(scope: MemoryScope, scopeId: string): number {
    return this.db.prepare('DELETE FROM memories WHERE scope = ? AND scope_id = ?').run(scope, scopeId).changes;
  }

  // ---- schedules ------------------------------------------------------------

  addSchedule(s: Omit<ScheduleRow, 'id' | 'enabled' | 'last_run_at' | 'created_at'>): ScheduleRow {
    const info = this.db
      .prepare(
        `INSERT INTO schedules (guild_id, channel_id, cron, tz, prompt, description, created_by, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(s.guild_id, s.channel_id, s.cron, s.tz, s.prompt, s.description, s.created_by, Date.now());
    return this.getSchedule(Number(info.lastInsertRowid))!;
  }

  getSchedule(id: number): ScheduleRow | undefined {
    return this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
  }

  listSchedules(filter: { channelId?: string; guildId?: string; enabledOnly?: boolean } = {}): ScheduleRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.channelId) {
      where.push('channel_id = ?');
      args.push(filter.channelId);
    }
    if (filter.guildId) {
      where.push('guild_id = ?');
      args.push(filter.guildId);
    }
    if (filter.enabledOnly) where.push('enabled = 1');
    const sql = `SELECT * FROM schedules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
    return this.db.prepare(sql).all(...args) as ScheduleRow[];
  }

  deleteSchedule(id: number, channelId?: string): boolean {
    if (channelId) {
      return this.db.prepare('DELETE FROM schedules WHERE id = ? AND channel_id = ?').run(id, channelId).changes > 0;
    }
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }

  markScheduleRun(id: number, at: number): void {
    this.db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(at, id);
  }

  // ---- runs -----------------------------------------------------------------

  startRun(r: { threadId: string; channelId: string; guildId: string | null; userId: string; trigger: string }): number {
    const info = this.db
      .prepare(
        `INSERT INTO runs (thread_id, channel_id, guild_id, user_id, trigger, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(r.threadId, r.channelId, r.guildId, r.userId, r.trigger, Date.now());
    return Number(info.lastInsertRowid);
  }

  finishRun(id: number, status: string, costUsd: number, turns: number): void {
    this.db
      .prepare('UPDATE runs SET status = ?, cost_usd = ?, turns = ?, ended_at = ? WHERE id = ?')
      .run(status, costUsd, turns, Date.now(), id);
  }

  /** Marks runs left 'running' by a crash/redeploy as interrupted. */
  sweepStaleRuns(): number {
    return this.db
      .prepare(`UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'`)
      .run(Date.now()).changes;
  }

  usageSince(guildId: string | null, since: number): { runs: number; cost: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost FROM runs
         WHERE (guild_id IS ? OR guild_id = ?) AND started_at >= ?`,
      )
      .get(guildId, guildId, since) as { runs: number; cost: number };
    return row;
  }

  // ---- settings ---------------------------------------------------------------

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else
      this.db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
  }

  // ---- ambient rate limiting --------------------------------------------------

  ambientCount(channelId: string, since: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM ambient_log WHERE channel_id = ? AND at >= ?')
      .get(channelId, since) as { n: number };
    return row.n;
  }

  logAmbient(channelId: string): void {
    this.db.prepare('INSERT INTO ambient_log (channel_id, at) VALUES (?, ?)').run(channelId, Date.now());
    // keep the table small
    this.db.prepare('DELETE FROM ambient_log WHERE at < ?').run(Date.now() - 7 * 24 * 3600 * 1000);
  }
}
