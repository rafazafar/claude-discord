import type { Effort } from './bundles.js';

/**
 * Per-message model and effort, e.g. "@Claude --sonnet --high fix the build".
 * Flags count only at the start of the message, so "--opus" later in normal text is left alone.
 */

export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Effort when neither the message, the channel nor the bundle sets one. */
export const DEFAULT_EFFORT: Effort = 'medium';

export interface RunFlags {
  model?: string;
  effort?: Effort;
  /** The message with the flags removed. */
  rest: string;
}

export function parseRunFlags(text: string): RunFlags {
  const out: RunFlags = { rest: text };
  let rest = text.trimStart();
  for (;;) {
    const m = rest.match(/^--([a-z]+)(?=\s|$)/i);
    if (!m) break;
    const name = m[1]!.toLowerCase();
    if (MODEL_ALIASES[name]) out.model = MODEL_ALIASES[name];
    else if ((EFFORTS as readonly string[]).includes(name)) out.effort = name as Effort;
    else break; // not one of ours: leave it in the text
    rest = rest.slice(m[0].length).trimStart();
  }
  out.rest = rest;
  return out;
}

/** The effort a run actually uses: Opus is capped at high, and unset means the default. */
export function effectiveEffort(model: string, requested: Effort | null | undefined): Effort {
  const effort = requested ?? DEFAULT_EFFORT;
  if (/opus/i.test(model) && (effort === 'xhigh' || effort === 'max')) return 'high';
  return effort;
}

/** "claude-sonnet-5-5" → "sonnet", for progress messages. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d.*$/, '');
}
