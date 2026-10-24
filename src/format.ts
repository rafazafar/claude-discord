/** Helpers for turning agent output into Discord messages. */

export const DISCORD_LIMIT = 2000;

/**
 * Splits text into chunks under `max` chars, preferring paragraph, then line,
 * then word boundaries, and re-opening code fences that span a split.
 */
export function splitMessage(input: string, max = 1900): string[] {
  const text = input.trim();
  if (!text) return [];
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let rest = text;
  let openFence: string | null = null; // e.g. "```ts"

  while (rest.length) {
    const prefix = openFence ? openFence + '\n' : '';
    const budget = max - prefix.length - 4; // room to close a fence
    if (prefix.length + rest.length <= max) {
      chunks.push(prefix + rest);
      break;
    }

    let cut = rest.lastIndexOf('\n\n', budget);
    if (cut < budget * 0.5) cut = rest.lastIndexOf('\n', budget);
    if (cut < budget * 0.5) cut = rest.lastIndexOf(' ', budget);
    if (cut <= 0) cut = budget;

    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\s+/, '');

    // Track fence state across this piece.
    const body = prefix + piece;
    let fence: string | null = openFence;
    for (const line of piece.split('\n')) {
      const m = line.match(/^\s*(```+)(\S*)/);
      if (m) fence = fence ? null : m[1] + (m[2] ?? '');
    }
    piece = body;
    if (fence) piece += '\n```';
    openFence = fence;
    chunks.push(piece);
  }
  return chunks;
}

/** Discord doesn't render markdown tables; convert them to aligned code blocks. */
export function tablesToCodeBlocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) inFence = !inFence;
    const next = lines[i + 1];
    const isTableStart =
      !inFence && /^\s*\|.*\|\s*$/.test(line) && next !== undefined && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(next);
    if (!isTableStart) {
      out.push(line);
      i++;
      continue;
    }
    const rows: string[][] = [];
    const parse = (l: string) =>
      l
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim().replace(/\*\*/g, ''));
    rows.push(parse(line));
    i += 2;
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
      rows.push(parse(lines[i]!));
      i++;
    }
    const cols = Math.max(...rows.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
    const fmt = (r: string[]) => widths.map((w, c) => (r[c] ?? '').padEnd(w)).join('  ').trimEnd();
    out.push('```', fmt(rows[0]!), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(fmt), '```');
  }
  return out.join('\n');
}

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n - 1) + '…';
}

/** A short thread title from a request. */
export function threadTitle(content: string): string {
  const cleaned = content
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/<#\d+>/g, '#channel')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[`*_~>|]/g, '')
    .trim();
  return truncate(cleaned || 'Claude task', 90);
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One-line human description of a tool call for the progress message. */
export function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  switch (name) {
    case 'WebSearch':
      return `🔎 Searching: ${truncate(s('query'), 80)}`;
    case 'WebFetch':
      return `🌐 Reading ${truncate(s('url'), 80)}`;
    case 'Bash':
      return `💻 \`${truncate(s('command'), 80).replace(/`/g, "'")}\``;
    case 'Read':
      return `📖 Reading ${truncate(s('file_path'), 80)}`;
    case 'Write':
      return `📝 Writing ${truncate(s('file_path'), 80)}`;
    case 'Edit':
      return `✏️ Editing ${truncate(s('file_path'), 80)}`;
    case 'Glob':
    case 'Grep':
      return `🔍 Searching files for ${truncate(s('pattern'), 60)}`;
    case 'TodoWrite':
      return '🗒️ Updating plan';
  }
  if (name.startsWith('mcp__discord__')) {
    const t = name.slice('mcp__discord__'.length);
    const labels: Record<string, string> = {
      remember: '🧠 Saving to channel memory',
      list_memories: '🧠 Checking channel memory',
      forget: '🧠 Removing a memory',
      set_reply_mode: '🔕 Changing reply mode',
      quiet_thread: '🔕 Going quiet in this thread',
      schedule_task: '🗓️ Scheduling standing work',
      list_schedules: '🗓️ Checking schedules',
      cancel_schedule: '🗓️ Cancelling a schedule',
      send_file: '📎 Uploading a file',
      read_channel_history: '📜 Reading channel history',
    };
    return labels[t] ?? `🔧 ${t}`;
  }
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return `🔌 ${server}: ${rest.join('__')}`;
  }
  return `🔧 ${name}`;
}
