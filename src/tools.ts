import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Cron } from 'croner';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Store, MemoryScope } from './db.js';

/**
 * In-process MCP server exposing Discord-side abilities to the agent:
 * channel memory, reply-mode control, standing scheduled work, sending files,
 * and reading more channel history.
 */

export interface ToolContext {
  store: Store;
  guildId: string | null;
  /** The channel whose config/memory applies (parent channel for threads, DM channel for DMs). */
  channelId: string;
  threadId: string;
  userId: string;
  /** Whether the requester is a server admin; gates the same actions the slash commands gate. */
  isAdmin: boolean;
  workspace: string;
  defaultTimezone: string;
  /** Upload a file into the current thread. */
  sendFile: (absPath: string, caption?: string) => Promise<void>;
  /** Fetch recent messages from the parent channel as plain text lines. */
  fetchHistory: (limit: number) => Promise<string[]>;
  /** Called after schedules change so the scheduler picks them up. */
  onSchedulesChanged: () => void;
  /** Called after the thread is asked to go quiet. */
  onQuietThread: () => void;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // Discord's default bot upload limit

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

export function validateCron(expr: string, tz: string): { ok: true; next: Date | null } | { ok: false; error: string } {
  try {
    const job = new Cron(expr, { timezone: tz, paused: true });
    const next = job.nextRun();
    job.stop();
    return { ok: true, next };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Resolves `p` against `root` and refuses anything that escapes it. */
export function resolveInside(root: string, p: string): string | null {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

export function buildDiscordTools(ctx: ToolContext) {
  const readScopes = (): Array<{ scope: MemoryScope; scopeId: string }> => {
    const s: Array<{ scope: MemoryScope; scopeId: string }> = [{ scope: 'channel', scopeId: ctx.channelId }];
    if (ctx.guildId) s.push({ scope: 'guild', scopeId: ctx.guildId });
    return s;
  };
  // Server-wide memory is admin-only to change, like /claude memory.
  const writeScopes = () => (ctx.isAdmin ? readScopes() : readScopes().filter((x) => x.scope === 'channel'));
  const adminOnly = (what: string) => fail(`Only server admins can ${what}. Ask an admin, or use /claude.`);

  const tools = [
    tool(
      'remember',
      'Save a standing instruction or fact so it applies to every future conversation in this channel (or the whole server). ' +
        'Use when someone says "remember…", "from now on…", "always/never…", or states a durable preference. Keep it one short sentence.',
      {
        content: z.string().min(1).max(500).describe('The instruction or fact, written as a short standalone sentence.'),
        scope: z.enum(['channel', 'server']).default('channel').describe('channel (default) or server-wide.'),
      },
      async ({ content, scope }) => {
        if (scope === 'server' && !ctx.guildId) return fail('Server-wide memory is not available in DMs.');
        if (scope === 'server' && !ctx.isAdmin) return adminOnly('save server-wide memory');
        const row = ctx.store.addMemory(
          scope === 'server' ? 'guild' : 'channel',
          scope === 'server' ? ctx.guildId! : ctx.channelId,
          content,
          ctx.userId,
        );
        return text(`Saved memory #${row.id} (${scope}).`);
      },
    ),

    tool('list_memories', 'List the standing instructions and facts saved for this channel and server.', {}, async () => {
      const rows = readScopes().flatMap((s) => ctx.store.listMemories(s.scope, s.scopeId));
      if (!rows.length) return text('No memories saved.');
      return text(rows.map((r) => `#${r.id} [${r.scope === 'guild' ? 'server' : 'channel'}] ${r.content}`).join('\n'));
    }),

    tool(
      'forget',
      'Delete a saved memory by its id (see list_memories).',
      { id: z.number().int().positive() },
      async ({ id }) =>
        ctx.store.deleteMemory(id, writeScopes()) ? text(`Deleted memory #${id}.`) : fail(`No memory #${id} that this requester can delete here.`),
    ),

    tool(
      'set_reply_mode',
      'Change when you reply in this channel. "mention": only when @-mentioned or in your own threads. ' +
        '"ambient": you may also jump in unprompted when you can clearly help. Use when someone asks you to be quieter or more proactive.',
      { mode: z.enum(['mention', 'ambient']) },
      async ({ mode }) => {
        if (!ctx.guildId) return fail('Reply mode only applies to server channels.');
        if (mode === 'ambient' && !ctx.isAdmin) return adminOnly('turn on ambient mode');
        return ctx.store.setReplyMode(ctx.channelId, mode, ctx.userId)
          ? text(`Reply mode for this channel is now "${mode}".`)
          : fail('This channel is not enabled.');
      },
    ),

    tool(
      'quiet_thread',
      'Stop replying in this thread unless someone @-mentions you again. Use when asked to stop, be quiet, or butt out of a thread.',
      {},
      async () => {
        ctx.store.setThreadQuiet(ctx.threadId, true);
        ctx.onQuietThread();
        return text('This thread is now quiet; I will reply only when @-mentioned.');
      },
    ),

    tool(
      'schedule_task',
      'Create standing work that runs on a schedule and posts results in this channel (e.g. a daily summary). ' +
        'Write `prompt` as a complete, standalone instruction: each run starts fresh with no memory of this conversation.',
      {
        cron: z.string().describe('Standard 5-field cron expression, e.g. "0 9 * * 1-5" for weekdays at 09:00.'),
        prompt: z.string().min(1).max(4000).describe('Full standalone instruction for each run.'),
        description: z.string().max(200).describe('Short human label, e.g. "Weekday standup summary".'),
        timezone: z.string().optional().describe('IANA timezone such as "Asia/Tokyo". Defaults to the bot default.'),
      },
      async ({ cron, prompt, description, timezone }) => {
        const tz = timezone || ctx.defaultTimezone;
        const v = validateCron(cron, tz);
        if (!v.ok) return fail(`Invalid schedule: ${v.error}`);
        const row = ctx.store.addSchedule({
          guild_id: ctx.guildId,
          channel_id: ctx.channelId,
          cron,
          tz,
          prompt,
          description,
          created_by: ctx.userId,
        });
        ctx.onSchedulesChanged();
        const next = v.next ? `<t:${Math.floor(v.next.getTime() / 1000)}:F>` : 'never';
        return text(`Created schedule #${row.id} "${description}" (${cron}, ${tz}). Next run: ${next}.`);
      },
    ),

    tool('list_schedules', 'List scheduled standing work for this channel.', {}, async () => {
      const rows = ctx.store.listSchedules({ channelId: ctx.channelId });
      if (!rows.length) return text('No schedules in this channel.');
      return text(rows.map((r) => `#${r.id} "${r.description}" — ${r.cron} (${r.tz})${r.enabled ? '' : ' [disabled]'}`).join('\n'));
    }),

    tool(
      'cancel_schedule',
      'Cancel a scheduled task in this channel by id.',
      { id: z.number().int().positive() },
      async ({ id }) => {
        const row = ctx.store.getSchedule(id);
        if (!row || row.channel_id !== ctx.channelId) return fail(`No schedule #${id} in this channel.`);
        if (row.created_by !== ctx.userId && !ctx.isAdmin) return fail('Only the person who created this schedule or an admin can cancel it.');
        const ok = ctx.store.deleteSchedule(id, ctx.channelId);
        if (ok) ctx.onSchedulesChanged();
        return ok ? text(`Cancelled schedule #${id}.`) : fail(`No schedule #${id} in this channel.`);
      },
    ),

    tool(
      'send_file',
      'Upload a file from your workspace into the Discord thread (reports, charts, CSVs, patches, images). Max 10 MB.',
      {
        path: z.string().describe('Path relative to your working directory.'),
        caption: z.string().max(1500).optional(),
      },
      async ({ path: p, caption }) => {
        const abs = resolveInside(ctx.workspace, p);
        if (!abs) return fail('Path must be inside your working directory.');
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          return fail(`File not found: ${p}`);
        }
        if (!st.isFile()) return fail(`${p} is not a file.`);
        if (st.size > MAX_UPLOAD_BYTES) return fail(`${p} is ${(st.size / 1e6).toFixed(1)} MB; the limit is 10 MB.`);
        await ctx.sendFile(abs, caption);
        return text(`Uploaded ${path.basename(abs)} to the thread.`);
      },
    ),

    tool(
      'read_channel_history',
      'Read recent messages from the channel this thread belongs to, newest last. Use for "catch me up", summaries, or missing context.',
      { limit: z.number().int().min(1).max(100).default(50) },
      async ({ limit }) => {
        const lines = await ctx.fetchHistory(limit);
        return text(lines.length ? lines.join('\n') : 'No messages.');
      },
    ),
  ];

  return createSdkMcpServer({
    name: 'discord',
    version: '0.1.0',
    instructions:
      'Tools for working inside Discord: channel memory, reply mode, scheduled standing work, uploading files, and reading channel history.',
    tools,
  });
}

export const DISCORD_TOOL_NAMES = [
  'remember',
  'list_memories',
  'forget',
  'set_reply_mode',
  'quiet_thread',
  'schedule_task',
  'list_schedules',
  'cancel_schedule',
  'send_file',
  'read_channel_history',
].map((n) => `mcp__discord__${n}`);
