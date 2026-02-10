import { EventEmitter } from 'events';
import type {
  RawTradeEvent,
  OrchestratorHealth,
  WatcherState,
} from '../types/index.js';
import { serializeEvent } from '../types/index.js';
import { BaseWatcher } from './base-watcher.js';
import { OnChainWatcher } from './on-chain-watcher.js';
import { ClobWatcher } from './clob-watcher.js';
import { Deduplicator } from '../dedup/deduplicator.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ module: 'orchestrator' });

/**
 * Event map for the orchestrator.
 */
export interface OrchestratorEvents {
  /** Emitted for every new, deduplicated expert trade */
  trade: (event: RawTradeEvent) => void;
  /** Emitted when a watcher encounters an error */
  error: (error: Error, watcherName: string) => void;
}

interface OrchestratorConfig {
  onChainWatcher: OnChainWatcher;
  clobWatcher: ClobWatcher;
  deduplicator: Deduplicator;
}

/**
 * Manages both watchers, deduplicates across sources, and exposes a
 * unified event stream. Both watchers run concurrently — the on-chain
 * watcher is primary (lower latency), the CLOB watcher is supplementary
 * (catches edge cases during RPC outages).
 */
export class WatcherOrchestrator extends EventEmitter {
  private onChainWatcher: OnChainWatcher;
  private clobWatcher: ClobWatcher;
  private deduplicator: Deduplicator;
  private startedAt: number | null = null;
  private totalEventsEmitted = 0;

  constructor(config: OrchestratorConfig) {
    super();
    this.onChainWatcher = config.onChainWatcher;
    this.clobWatcher = config.clobWatcher;
    this.deduplicator = config.deduplicator;

    this.wireWatcher(this.onChainWatcher);
    this.wireWatcher(this.clobWatcher);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.startedAt = Date.now();
    log.info('Starting watcher orchestrator...');

    // Start on-chain watcher first (primary)
    try {
      await this.onChainWatcher.start();
    } catch (err) {
      log.error({ err }, 'On-chain watcher failed to start — continuing with CLOB only');
    }

    // Start CLOB watcher (secondary/supplementary)
    try {
      await this.clobWatcher.start();
    } catch (err) {
      log.error({ err }, 'CLOB watcher failed to start');
    }

    // Check that at least one watcher is running
    const health = this.getHealth();
    if (health.status === 'unhealthy') {
      throw new Error('All watchers failed to start — cannot proceed');
    }

    log.info({ status: health.status }, 'Watcher orchestrator started');
  }

  async stop(): Promise<void> {
    log.info('Stopping watcher orchestrator...');

    const results = await Promise.allSettled([
      this.onChainWatcher.stop(),
      this.clobWatcher.stop(),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        log.error({ err: result.reason }, 'Watcher stop error');
      }
    }

    log.info('Watcher orchestrator stopped');
  }

  // ─── Health ──────────────────────────────────────────────────────────

  getHealth(): OrchestratorHealth {
    const watchers = [
      this.onChainWatcher.getHealth(),
      this.clobWatcher.getHealth(),
    ];

    const runningCount = watchers.filter((w) => w.state === 'running').length;

    let status: OrchestratorHealth['status'];
    if (runningCount === watchers.length) {
      status = 'healthy';
    } else if (runningCount > 0) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    return {
      status,
      watchers,
      totalEventsDetected: this.totalEventsEmitted,
      dedupHits: this.deduplicator.hits,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  // ─── Internal Wiring ─────────────────────────────────────────────────

  private wireWatcher(watcher: BaseWatcher): void {
    watcher.on('trade', (event: RawTradeEvent) => {
      this.handleTradeEvent(event);
    });

    watcher.on('error', (error: Error) => {
      log.error(
        { err: error, watcher: watcher.name },
        'Watcher error'
      );
      this.emit('error', error, watcher.name);
    });

    watcher.on('stateChange', (state: WatcherState) => {
      log.info(
        { watcher: watcher.name, state },
        'Watcher state changed'
      );
    });
  }

  private handleTradeEvent(event: RawTradeEvent): void {
    const result = this.deduplicator.process(event);

    if (result.isNew) {
      this.totalEventsEmitted++;
      log.info(
        {
          id: event.id,
          source: event.source,
          exchange: event.exchange,
          expertSide: event.expertSide,
          txHash: event.txHash,
        },
        'New expert trade detected'
      );

      // Log the full serialized event for shadow mode auditing
      log.debug(
        { event: serializeEvent(event) },
        'Full trade event details'
      );

      this.emit('trade', event);
    }
  }
}
