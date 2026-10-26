import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './db.js';
import { log, errMsg } from './log.js';

/**
 * Deletes conversation working folders (clones, attachments, outputs) after a stretch of
 * inactivity, so the data volume doesn't grow with every task. The conversation itself is
 * kept: a later reply resumes the session, and the agent is told its folder was cleared.
 */

const DAY_MS = 24 * 3600 * 1000;

export async function sweepWorkspaces(opts: {
  store: Store;
  workspacesDir: string;
  retentionDays: number;
  isBusy: (key: string) => boolean;
  now?: number;
}): Promise<number> {
  const root = path.resolve(opts.workspacesDir) + path.sep;
  const before = (opts.now ?? Date.now()) - opts.retentionDays * DAY_MS;
  let removed = 0;
  for (const t of opts.store.listInactiveThreads(before)) {
    const dir = path.resolve(t.cwd);
    // Only ever delete inside the workspaces root, and never under a running task.
    if (!dir.startsWith(root) || opts.isBusy(t.thread_id) || !fs.existsSync(dir)) continue;
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      removed++;
    } catch (e) {
      log.warn('workspace cleanup failed', { dir, error: errMsg(e) });
    }
  }
  if (removed) log.info('cleaned up inactive workspaces', { removed, retentionDays: opts.retentionDays });
  return removed;
}

/** Runs the sweep now and then daily. */
export function scheduleWorkspaceCleanup(opts: Parameters<typeof sweepWorkspaces>[0]): NodeJS.Timeout {
  const run = () => void sweepWorkspaces(opts).catch((e) => log.error('workspace cleanup crashed', { error: errMsg(e) }));
  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return timer;
}
