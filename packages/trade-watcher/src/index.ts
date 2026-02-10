import { loadConfig } from './config/index.js';
import { getDatabase, closeDatabase } from './store/database.js';
import { EventStore } from './store/event-store.js';
import { NormalizedStore } from './store/normalized-store.js';
import { Deduplicator } from './dedup/deduplicator.js';
import { OnChainWatcher } from './watchers/on-chain-watcher.js';
import { ClobWatcher } from './watchers/clob-watcher.js';
import { WatcherOrchestrator } from './watchers/watcher-orchestrator.js';
import { SignalNormalizer } from './normalizer/index.js';
import { startHealthServer, stopHealthServer } from './utils/health.js';
import { getLogger } from './utils/logger.js';
import type { RawTradeEvent } from './types/index.js';
import type { NormalizedTrade } from './normalizer/types.js';
import { serializeNormalizedTrade } from './normalizer/types.js';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const log = getLogger();

  log.info('═══════════════════════════════════════════════════════');
  log.info('  Polytera Trade Watcher + Signal Normalizer — Starting');
  log.info('═══════════════════════════════════════════════════════');
  log.info({ expertAddress: config.expertAddress }, 'Target expert');

  // ── Database & Stores ──────────────────────────────────────────────
  const db = getDatabase(config.env.DB_PATH);
  const eventStore = new EventStore(db);
  const normalizedStore = new NormalizedStore(db);
  const deduplicator = new Deduplicator(eventStore);

  log.info(
    {
      rawEvents: eventStore.getEventCount(),
      normalizedEvents: normalizedStore.getCount(),
    },
    'Stores initialized'
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

  // ── Signal Normalizer ──────────────────────────────────────────────
  const normalizer = new SignalNormalizer({
    expertAddress: config.expertAddress,
  });

  // Wire: raw trade -> normalize -> persist -> log
  orchestrator.on('trade', async (event: RawTradeEvent) => {
    const normalized = await normalizer.normalize(event);

    if (normalized) {
      // Persist for auditing
      normalizedStore.insert(normalized);

      // Shadow mode: log the enriched trade
      const serialized = serializeNormalizedTrade(normalized);
      log.info(
        {
          trade: {
            id: serialized.expertTradeId,
            market: serialized.marketQuestion,
            outcome: serialized.outcome,
            side: serialized.side,
            price: serialized.price,
            quantity: serialized.quantity,
            impliedProbability: serialized.impliedProbability,
            phase: serialized.marketPhase,
            positionBefore: serialized.expertPositionBefore,
            positionAfter: serialized.expertPositionAfter,
            liquidity: serialized.liquiditySnapshot,
            latencyMs: serialized.normalizationLatencyMs,
            txHash: serialized.txHash,
          },
        },
        'SHADOW MODE — Normalized expert trade'
      );
    }
  });

  // Forward the normalized event for future Context Analyzer module
  normalizer.on('normalized', (_normalized: NormalizedTrade) => {
    // Integration point: contextAnalyzer.analyze(normalized)
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
    'System is live'
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
