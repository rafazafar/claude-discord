import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

/**
 * Privilege separation. In the Docker image the bot runs as root and every agent
 * process (Claude Code + its shell) runs as the unprivileged AGENT_USER via
 * setpriv. That keeps the Discord token, the bot's full environment (/proc/<pid>/environ)
 * and the SQLite database out of reach of anything the agent runs.
 *
 * Outside Docker (local dev) AGENT_USER is unset and agents run as the current user.
 */

interface AgentIds {
  user: string;
  uid: number;
  gid: number;
}

let ids: AgentIds | null | undefined;

function lookup(user: string): AgentIds {
  const line = fs
    .readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .find((l) => l.split(':')[0] === user);
  if (!line) throw new Error(`AGENT_USER "${user}" does not exist in /etc/passwd`);
  const parts = line.split(':');
  return { user, uid: Number(parts[2]), gid: Number(parts[3]) };
}

export function agentIds(): AgentIds | null {
  if (ids !== undefined) return ids;
  const user = process.env.AGENT_USER?.trim();
  if (!user) {
    ids = null;
    return ids;
  }
  ids = lookup(user);
  if (process.getuid?.() !== 0) {
    log.warn('AGENT_USER is set but the bot is not root; agents will run as the bot user', { user });
    ids = null;
  }
  return ids;
}

/** mkdir -p, then hand the directory (and any parents we created) to the agent user. */
export function ensureAgentDir(dir: string): void {
  const created = fs.mkdirSync(dir, { recursive: true });
  const a = agentIds();
  if (!a) return;
  // chown from the first newly created ancestor down to `dir`
  const target = path.resolve(dir);
  const dirs = [target];
  if (created) {
    let p = target;
    const top = path.resolve(created);
    while (p !== top && p !== path.dirname(p)) {
      p = path.dirname(p);
      dirs.push(p);
    }
  }
  for (const d of dirs) {
    try {
      fs.chownSync(d, a.uid, a.gid);
    } catch {
      /* ignore */
    }
  }
}

export function giveToAgent(file: string): void {
  const a = agentIds();
  if (!a) return;
  try {
    fs.chownSync(file, a.uid, a.gid);
  } catch {
    /* ignore */
  }
}

/** Directory only the bot can read (for the database). */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
}

function realClaudeBinary(): string {
  const require = createRequire(import.meta.url);
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
  return path.join(path.dirname(require.resolve(pkg)), 'claude');
}

/**
 * Extra Agent SDK options/env that make the CLI run as the agent user.
 * Returns nothing when privilege separation is off.
 */
export function agentLaunch(): { pathToClaudeCodeExecutable?: string; env: Record<string, string> } {
  const a = agentIds();
  if (!a) return { env: {} };
  const wrapper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-as-agent.sh');
  return {
    pathToClaudeCodeExecutable: wrapper,
    env: { CLAUDE_REAL_BIN: realClaudeBinary(), AGENT_USER: a.user },
  };
}
