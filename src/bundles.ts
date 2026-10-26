import fs from 'node:fs';
import { z } from 'zod';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { log, errMsg } from './log.js';

/**
 * Access bundles: named sets of capabilities, credentials and limits.
 * Admins attach one bundle to each channel with `/claude enable bundle:<name>`.
 * Mirrors Claude Tag's "Access bundles": Claude starts with no access, and you
 * decide per channel what it can reach.
 */

export const Capability = z.enum(['web', 'code', 'github']);
export type Capability = z.infer<typeof Capability>;

/** How hard Claude thinks; higher is slower and costs more. Unset uses the model's default. */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

const McpStdio = z.object({
  type: z.literal('stdio').optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const McpRemote = z.object({
  type: z.enum(['http', 'sse']),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});
const McpServer = z.union([McpRemote, McpStdio]);

const GithubSchema = z.object({
  /** Name of the env var holding a GitHub token (fine-grained PAT scoped to `repos`). */
  tokenEnv: z.string().default('GITHUB_TOKEN'),
  /** owner/repo entries Claude is told it may work on. Enforce with the token's scope. */
  repos: z.array(z.string()).default([]),
  gitName: z.string().default('zClaude (Discord)'),
  gitEmail: z.string().default('claude-bot@users.noreply.github.com'),
});

export const BundleSchema = z.object({
  description: z.string().default(''),
  capabilities: z.array(Capability).default(['web']),
  github: GithubSchema.optional(),
  // Names become tool prefixes (mcp__<name>__tool), so keep them to letters, digits, _ and -.
  mcpServers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/, 'MCP server names may only use letters, digits, _ and -'), McpServer).default({}),
  /** If non-empty, only members with one of these roles can hand Claude work in channels on this bundle. */
  allowedRoleIds: z.array(z.string()).default([]),
  model: z.string().optional(),
  /** Default effort for channels on this bundle; admins can override per channel with /claude effort. */
  effort: Effort.optional(),
  maxTurns: z.number().int().positive().default(80),
  /** Optional spend cap per task. Unset (the default): no cap, so one big task isn't cut off midway. */
  maxBudgetUsd: z.number().positive().optional(),
  /** Extra standing instructions for every session on this bundle. */
  instructions: z.string().default(''),
  /** Skills from config/plugin/skills Claude may use here, by directory name, or "all". Needs `code`. */
  skills: z.union([z.literal('all'), z.array(z.string())]).default([]),
});
export type Bundle = z.infer<typeof BundleSchema>;

const AmbientSchema = z.object({
  /** Max unprompted replies per channel per rolling hour. */
  maxPerHour: z.number().int().min(0).default(4),
  /** Messages shorter than this are never considered for ambient replies. */
  minMessageLength: z.number().int().min(0).default(20),
  /** Recent messages shown to the ambient classifier. */
  contextMessages: z.number().int().min(1).max(50).default(12),
});

export const BundlesFileSchema = z.object({
  bundles: z.record(z.string(), BundleSchema),
  dm: z
    .object({
      /** Bundle used for direct messages. null disables DMs. */
      bundle: z.string().nullable().default(null),
      /** If non-empty, only these user IDs may DM the bot. */
      allowedUserIds: z.array(z.string()).default([]),
    })
    .default({ bundle: null, allowedUserIds: [] }),
  ambient: AmbientSchema.default({ maxPerHour: 4, minMessageLength: 20, contextMessages: 12 }),
});
export type BundlesFile = z.infer<typeof BundlesFileSchema>;

/** Replaces ${VAR} with process.env.VAR in every string, recursively. */
export function substituteEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => env[name] ?? '') as T;
  }
  if (Array.isArray(value)) return value.map((v) => substituteEnv(v, env)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v, env)])) as T;
  }
  return value;
}

export function parseBundlesFile(raw: unknown): BundlesFile {
  const file = BundlesFileSchema.parse(raw);
  for (const [name, b] of Object.entries(file.bundles)) {
    if (b.capabilities.includes('github') && !b.capabilities.includes('code')) {
      // GitHub work needs a shell and file tools.
      b.capabilities.push('code');
      log.info('bundle: github implies code', { bundle: name });
    }
    if (b.skills.length && !b.capabilities.includes('code')) {
      // Skills keep their reference files next to SKILL.md; Claude needs file tools to read them.
      throw new Error(`bundle "${name}": skills need the "code" capability`);
    }
  }
  if (file.dm.bundle && !file.bundles[file.dm.bundle]) {
    throw new Error(`dm.bundle "${file.dm.bundle}" is not defined in bundles`);
  }
  return file;
}

export class BundleRegistry {
  private file: BundlesFile;

  constructor(private readonly path: string) {
    this.file = this.read();
    fs.watchFile(path, { interval: 5000 }, () => {
      try {
        this.file = this.read();
        log.info('bundles reloaded', { bundles: Object.keys(this.file.bundles) });
      } catch (e) {
        log.error('bundles reload failed; keeping previous config', { error: errMsg(e) });
      }
    });
  }

  private read(): BundlesFile {
    const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    return parseBundlesFile(raw);
  }

  get(name: string): Bundle | undefined {
    return this.file.bundles[name];
  }

  names(): string[] {
    return Object.keys(this.file.bundles);
  }

  get dm() {
    return this.file.dm;
  }

  get ambient() {
    return this.file.ambient;
  }

  /** MCP server configs for a bundle with ${ENV} references resolved. */
  mcpServers(bundle: Bundle): Record<string, McpServerConfig> {
    return substituteEnv(bundle.mcpServers) as Record<string, McpServerConfig>;
  }
}
