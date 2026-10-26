import type { Client } from 'discord.js';

/**
 * The bot's own name, as people see it in Discord (e.g. "zClaude"). User-facing text and the
 * right-click entries use it, so renaming the bot in the Developer Portal needs no code change.
 * "Claude" stays only where text means Anthropic's product (the account, Console, plan sign-in).
 */
export const DEFAULT_BOT_NAME = 'zClaude';

export function botName(client: Client | undefined): string {
  return client?.user?.displayName ?? DEFAULT_BOT_NAME;
}
