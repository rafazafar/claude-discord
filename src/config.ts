import path from 'node:path';
import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_APP_ID: z.string().min(1, 'DISCORD_APP_ID is required'),
  /**
   * Which credential the agent uses.
   *  - api_key:     ANTHROPIC_API_KEY (pay-as-you-go, or Max/Team monthly API credits
   *                 when the key comes from the Console org linked to your plan)
   *  - oauth_token: CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` (draws on plan usage limits)
   * Unset: api_key if ANTHROPIC_API_KEY is present, otherwise oauth_token.
   * Admins can switch at runtime with /zclaude auth when both are configured.
   */
  AUTH_MODE: z.enum(['api_key', 'oauth_token']).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),

  /** Model for working sessions. */
  CLAUDE_MODEL: z.string().default('claude-opus-5-5'),
  /** Small, fast model that decides whether to jump in on un-tagged messages. */
  AMBIENT_MODEL: z.string().default('claude-haiku-5-5'),

  DATA_DIR: z.string().default('/data'),
  BUNDLES_FILE: z.string().default(path.resolve('config/bundles.json')),

  /** Discord role / user IDs that can run admin commands, in addition to anyone with Manage Server. */
  ADMIN_ROLE_IDS: csv,
  ADMIN_USER_IDS: csv,

  /** Register slash commands to one guild instantly (dev). Otherwise registered globally. */
  DEV_GUILD_ID: z.string().optional(),

  /** IANA timezone used for schedules when none is given. */
  DEFAULT_TIMEZONE: z.string().default('UTC'),

  /** How many runs may execute at once across the whole bot. */
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(4),

  /** Messages of recent channel history passed as context when tagged in a channel. */
  CONTEXT_MESSAGES: z.coerce.number().int().min(0).max(100).default(25),

  /** Days without activity before a conversation's working folder (clones, files) is deleted. */
  WORKSPACE_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof EnvSchema> & {
  dbPath: string;
  workspacesDir: string;
  agentHome: string;
  pluginDir: string;
  gitCacheDir: string;
};

function load(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Invalid environment:\n${issues}`);
    process.exit(1);
  }
  const env = parsed.data;
  if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error('Invalid environment:\n  - set ANTHROPIC_API_KEY and/or CLAUDE_CODE_OAUTH_TOKEN');
    process.exit(1);
  }
  if (env.AUTH_MODE === 'api_key' && !env.ANTHROPIC_API_KEY) {
    console.error('Invalid environment:\n  - AUTH_MODE=api_key requires ANTHROPIC_API_KEY');
    process.exit(1);
  }
  if (env.AUTH_MODE === 'oauth_token' && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error('Invalid environment:\n  - AUTH_MODE=oauth_token requires CLAUDE_CODE_OAUTH_TOKEN');
    process.exit(1);
  }
  return {
    ...env,
    // Kept in a root-only directory so the agent's shell can't read or rewrite it.
    dbPath: path.join(env.DATA_DIR, 'bot', 'bot.sqlite'),
    workspacesDir: path.join(env.DATA_DIR, 'workspaces'),
    // HOME for the agent process: Claude Code keeps session transcripts under ~/.claude,
    // so it must live on the persistent volume for threads to resume after a redeploy.
    agentHome: path.join(env.DATA_DIR, 'home'),
    // Team skills ship next to bundles.json as a local Claude Code plugin.
    pluginDir: path.join(path.dirname(env.BUNDLES_FILE), 'plugin'),
    // Shared bare mirrors of GitHub repos; clone-repo clones from them with --reference.
    gitCacheDir: path.join(env.DATA_DIR, 'git-cache'),
  };
}

let cached: Config | undefined;
export function config(): Config {
  cached ??= load();
  return cached;
}
