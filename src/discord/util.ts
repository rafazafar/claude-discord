import path from 'node:path';
import {
  PermissionFlagsBits,
  type Collection,
  type GuildMember,
  type Message,
  type TextBasedChannel,
  type APIInteractionGuildMember,
} from 'discord.js';
import type { Config } from '../config.js';
import { truncate } from '../format.js';

export function formatMessageLine(m: Message): string {
  const t = m.createdAt.toISOString().slice(0, 16).replace('T', ' ');
  const name = m.member?.displayName ?? m.author.displayName ?? m.author.username;
  const who = m.author.bot ? `${name} [bot]` : name;
  let body = m.cleanContent || '';
  if (m.attachments.size) body += ` [${m.attachments.size} attachment${m.attachments.size > 1 ? 's' : ''}]`;
  if (m.embeds.length && !body) body = '[embed]';
  return `[${t}] ${who}: ${truncate(body, 1200)}`;
}

/** Fetches up to `limit` messages before `before` (or latest), oldest first. */
export async function fetchLines(channel: TextBasedChannel, limit: number, before?: string): Promise<string[]> {
  return (await fetchMessages(channel, limit, before)).map(formatMessageLine);
}

/** Like fetchLines, but the messages themselves (system messages skipped), oldest first. */
export async function fetchMessages(channel: TextBasedChannel, limit: number, before?: string): Promise<Message[]> {
  if (limit <= 0) return [];
  const out: Message[] = [];
  let cursor = before;
  let remaining = limit;
  while (remaining > 0) {
    const batch: Collection<string, Message> = await channel.messages.fetch({
      limit: Math.min(100, remaining),
      ...(cursor ? { before: cursor } : {}),
    });
    if (!batch.size) break;
    const sorted = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const m of sorted) {
      if (m.system) continue;
      out.push(m);
    }
    cursor = sorted[sorted.length - 1]!.id;
    remaining -= batch.size;
    if (batch.size < 100) break;
  }
  return out.reverse();
}

export function stripBotMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').replace(/\s+/g, ' ').trim();
}

export function workspaceFor(cfg: Config, guildId: string | null, channelId: string, key: string): string {
  const safe = (s: string) => s.replace(/[^\w-]/g, '_');
  return guildId
    ? path.join(cfg.workspacesDir, safe(guildId), safe(channelId), safe(key))
    : path.join(cfg.workspacesDir, 'dm', safe(key));
}

type AnyMember = GuildMember | APIInteractionGuildMember | null | undefined;

function memberRoleIds(member: AnyMember): string[] {
  if (!member) return [];
  const roles = member.roles;
  if (Array.isArray(roles)) return roles;
  return [...roles.cache.keys()];
}

export function isAdmin(cfg: Config, userId: string, member: AnyMember): boolean {
  if (cfg.ADMIN_USER_IDS.includes(userId)) return true;
  if (memberRoleIds(member).some((r) => cfg.ADMIN_ROLE_IDS.includes(r))) return true;
  if (!member) return false;
  const perms = member.permissions;
  if (typeof perms === 'string') return (BigInt(perms) & PermissionFlagsBits.ManageGuild) === PermissionFlagsBits.ManageGuild;
  return perms.has(PermissionFlagsBits.ManageGuild);
}

export function hasAnyRole(member: AnyMember, roleIds: string[]): boolean {
  if (!roleIds.length) return true;
  return memberRoleIds(member).some((r) => roleIds.includes(r));
}
