import { loadConfig } from './config/index.js';
import { getDatabase, closeDatabase } from './store/database.js';
import { EventStore } from './store/event-store.js';
import { Deduplicator } from './dedup/deduplicator.js';
import { OnChainWatcher } from './watchers/on-chain-watcher.js';
import { ClobWatcher } from './watchers/clob-watcher.js';
import { WatcherOrchestrator } from './watchers/watcher-orchestrator.js';
import { startHealthServer, stopHealthServer } from './utils/health.js';
import { getLogger } from './utils/logger.js';
import { serializeEvent } from './types/index.js';
import type { RawTradeEvent } from './types/index.js';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const log = getLogger();

  log.info('═══════════════════════════════════════════════════════');
  log.info('  Polytera Trade Watcher — Starting');
  log.info('═══════════════════════════════════════════════════════');
  log.info({ expertAddress: config.expertAddress }, 'Target expert');

  // ── Database & Store ───────────────────────────────────────────────
  const db = getDatabase(config.env.DB_PATH);
  const eventStore = new EventStore(db);
  const deduplicator = new Deduplicator(eventStore);

  log.info(
    { existingEvents: eventStore.getEventCount() },
    'Event store initialized'
  );

  // ── Watchers ───────────────────────────────────────────────────────
  const onChainWatcher = new OnChainWatcher({
    wssUrl: config.env.POLYGON_RPC_WSS,
    httpUrl: config.env.POLYGON_RPC_HTTP,
    expertAddress: config.expertAddress,
    eventStore,
  });

  const clobWatcher = new ClobWatcher({
    expertAddress: config.expertAddress,
    pollIntervalMs: config.env.CLOB_POLL_INTERVAL_MS,
  });

  // ── Orchestrator ───────────────────────────────────────────────────
  const orchestrator = new WatcherOrchestrator({
    onChainWatcher,
    clobWatcher,
    deduplicator,
  });

  // ── Shadow Mode Output ─────────────────────────────────────────────
  // In shadow mode, we log every detected trade to console.
  // When the Signal Normalizer module is built, this becomes the
  // integration point: orchestrator.on('trade', signalNormalizer.process)
  orchestrator.on('trade', (event: RawTradeEvent) => {
    const serialized = serializeEvent(event);
    log.info(
      {
        trade: {
          id: serialized.id,
          source: serialized.source,
          exchange: serialized.exchange,
          expertSide: serialized.expertSide,
          maker: serialized.maker,
          taker: serialized.taker,
          makerAssetId: serialized.makerAssetId,
          takerAssetId: serialized.takerAssetId,
          makerAmountFilled: serialized.makerAmountFilled,
          takerAmountFilled: serialized.takerAmountFilled,
          blockNumber: serialized.blockNumber,
          txHash: serialized.txHash,
        },
      },
      '🔔 SHADOW MODE — Expert trade detected'
    );
  });

  orchestrator.on('error', (error: Error, watcherName: string) => {
    log.error({ err: error, watcher: watcherName }, 'Orchestrator error');
  });

  // ── Health Server ──────────────────────────────────────────────────
  startHealthServer(orchestrator, config.env.HEALTH_PORT);

  // ── Start ──────────────────────────────────────────────────────────
  await orchestrator.start();

  const health = orchestrator.getHealth();
  log.info(
    { status: health.status, watchers: health.watchers.map((w) => `${w.name}:${w.state}`) },
    'Trade Watcher is live'
  );

  // ── Graceful Shutdown ──────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');

    try {
      await orchestrator.stop();
      stopHealthServer();
      closeDatabase();
      log.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep the process alive
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'Unhandled rejection');
    shutdown('unhandledRejection');
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
