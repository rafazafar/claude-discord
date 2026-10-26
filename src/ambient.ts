import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AuthManager } from './auth.js';
import { log, errMsg } from './log.js';
import { baseAgentEnv } from './agent.js';
import { agentLaunch } from './sandbox.js';

/**
 * Decides whether Claude should jump into a channel conversation without being tagged.
 * Runs through the Agent SDK (no tools, one turn) so it uses the same credential
 * switch as working sessions.
 */

export interface AmbientDecision {
  reply: boolean;
  reason: string;
}

const system = (bot: string) => `You decide whether an AI teammate named ${bot} should jump into a Discord conversation without being asked.
${bot} should reply ONLY when ALL are true:
- The latest message contains a question, request or problem ${bot} could concretely help with (facts, code, debugging, research, summarising, planning).
- It is not purely social chatter, a reaction, an acknowledgement, or a message clearly addressed to a specific person.
- Nobody has already answered it adequately in the recent messages.
- Replying would be welcome rather than intrusive, given any channel instructions.
When unsure, do not reply.
Respond with ONLY a JSON object: {"reply": true|false, "reason": "<10 words>"}`;

export function parseDecision(text: string): AmbientDecision {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { reply: false, reason: 'unparseable' };
  try {
    const obj = JSON.parse(m[0]) as { reply?: unknown; reason?: unknown };
    return { reply: obj.reply === true, reason: typeof obj.reason === 'string' ? obj.reason : '' };
  } catch {
    return { reply: false, reason: 'unparseable' };
  }
}

export async function shouldJumpIn(opts: {
  auth: AuthManager;
  model: string;
  agentHome: string;
  cwd: string;
  history: string[];
  latest: string;
  memories: string[];
  botName: string;
}): Promise<AmbientDecision> {
  const prompt = [
    opts.memories.length ? `Channel instructions:\n${opts.memories.map((m) => `- ${m}`).join('\n')}\n` : '',
    `Recent messages (oldest first):\n${opts.history.join('\n') || '(none)'}\n`,
    `Latest message:\n${opts.latest}`,
  ].join('\n');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45_000);
  try {
    const q = query({
      prompt,
      options: {
        model: opts.model,
        cwd: opts.cwd,
        systemPrompt: system(opts.botName),
        tools: [],
        allowedTools: [],
        maxTurns: 1,
        permissionMode: 'dontAsk',
        permissionPrompts: 'none',
        settingSources: [],
        persistSession: false,
        abortController: ac,
        env: baseAgentEnv(opts.agentHome, opts.auth.credentialEnv()),
        pathToClaudeCodeExecutable: agentLaunch().pathToClaudeCodeExecutable,
      },
    });
    let text = '';
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result' && msg.subtype === 'success') text = msg.result;
    }
    return parseDecision(text);
  } catch (e) {
    log.warn('ambient check failed', { error: errMsg(e) });
    return { reply: false, reason: 'error' };
  } finally {
    clearTimeout(timer);
  }
}
