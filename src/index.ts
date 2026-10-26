import path from 'node:path';
import { Client, Events, GatewayIntentBits, Partials, ActivityType } from 'discord.js';
import { config } from './config.js';
import { Store } from './db.js';
import { BundleRegistry } from './bundles.js';
import { AuthManager, AUTH_LABEL } from './auth.js';
import { RunManager } from './discord/runs.js';
import { MessageHandler } from './discord/handler.js';
import { CommandHandler, registerCommands } from './discord/commands.js';
import { Scheduler } from './scheduler.js';
import { log, errMsg } from './log.js';
import { botName } from './botname.js';
import { scheduleWorkspaceCleanup } from './cleanup.js';
import { agentIds, ensureAgentDir, ensurePrivateDir } from './sandbox.js';

async function main() {
  const cfg = config();
  ensurePrivateDir(path.dirname(cfg.dbPath));
  ensureAgentDir(cfg.workspacesDir);
  ensureAgentDir(cfg.agentHome);
  ensureAgentDir(cfg.gitCacheDir);
  const agent = agentIds();
  log.info('agent isolation', { runAs: agent ? agent.user : 'same user as bot (dev mode)' });

  const store = new Store(cfg.dbPath);
  const swept = store.sweepStaleRuns();
  if (swept) log.warn('marked interrupted runs from previous process', { count: swept });

  const bundles = new BundleRegistry(cfg.BUNDLES_FILE);
  const auth = new AuthManager(cfg, store);
  log.info('starting', { bundles: bundles.names(), auth: auth.mode(), model: cfg.CLAUDE_MODEL });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
    // Never ping @everyone/@here or roles from anything the bot posts.
    allowedMentions: { parse: ['users'], repliedUser: false },
  });

  let runs: RunManager;
  const scheduler = new Scheduler(client, store, cfg, () => runs);
  runs = new RunManager({ store, bundles, auth, cfg, onSchedulesChanged: () => scheduler.reload(), botName: () => botName(client) });
  const messages = new MessageHandler({ client, store, bundles, auth, cfg, runs });
  const commands = new CommandHandler({ client, store, bundles, auth, cfg, runs, scheduler });

  client.once(Events.ClientReady, async (c) => {
    log.info('connected to Discord', { user: c.user.tag, guilds: c.guilds.cache.size, credential: AUTH_LABEL[auth.mode()] });
    c.user.setActivity('tag @' + c.user.username + ' with a task', { type: ActivityType.Custom });
    try {
      await registerCommands(cfg, botName(c));
    } catch (e) {
      log.error('failed to register slash commands', { error: errMsg(e) });
    }
    scheduler.reload();
    scheduleWorkspaceCleanup({
      store,
      workspacesDir: cfg.workspacesDir,
      retentionDays: cfg.WORKSPACE_RETENTION_DAYS,
      isBusy: (key) => runs.isBusy(key),
    });
  });
  client.on(Events.MessageCreate, (m) => void messages.onMessage(m));
  client.on(Events.InteractionCreate, (i) => void commands.onInteraction(i));
  client.on(Events.Error, (e) => log.error('discord client error', { error: errMsg(e) }));

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { sig, active: runs.activeCount });
    scheduler.stop();
    runs.stopAll();
    // Give aborted runs a moment to post "Stopped" before disconnecting.
    await new Promise((r) => setTimeout(r, 3000));
    await client.destroy();
    store.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: errMsg(e) }));

  await client.login(cfg.DISCORD_TOKEN);
}

main().catch((e) => {
  log.error('fatal', { error: errMsg(e) });
  process.exit(1);
});
