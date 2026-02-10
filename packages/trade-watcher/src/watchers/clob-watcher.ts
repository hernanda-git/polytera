import { BaseWatcher } from './base-watcher.js';
import type { RawTradeEvent } from '../types/index.js';
import { buildEventId } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { withRetry, sleep } from '../utils/retry.js';

const log = createChildLogger({ module: 'clob-watcher' });

// ─── Polymarket Data API response shape ──────────────────────────────────────

interface ClobTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DATA_API_BASE = 'https://data-api.polymarket.com';

interface ClobWatcherConfig {
  expertAddress: string;
  pollIntervalMs: number;
}

/**
 * Secondary data source: polls the Polymarket public Data API for expert trades.
 *
 * This watcher catches trades that the on-chain listener might miss during
 * RPC outages or WebSocket disconnections. It uses no authentication — the
 * Data API `/trades` endpoint is public.
 */
export class ClobWatcher extends BaseWatcher {
  private config: ClobWatcherConfig;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  /** Track the most recent trade timestamp to only fetch newer trades */
  private lastSeenTimestamp = 0;

  constructor(config: ClobWatcherConfig) {
    super('clob-api');
    this.config = config;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.state === 'running') return;
    this.setState('starting');
    this.startedAt = Date.now();
    this.isShuttingDown = false;

    // Do an initial fetch to establish baseline
    try {
      await this.poll();
      this.setState('running');
      this.schedulePoll();
      log.info(
        { pollIntervalMs: this.config.pollIntervalMs },
        'CLOB watcher started'
      );
    } catch (err) {
      this.setState('failed');
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error }, 'Failed to start CLOB watcher');
      this.emitError(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.setState('stopped');
    log.info('CLOB watcher stopped');
  }

  // ─── Polling ─────────────────────────────────────────────────────────

  private schedulePoll(): void {
    if (this.isShuttingDown) return;

    this.pollTimer = setTimeout(async () => {
      try {
        await this.poll();

        if (this.state !== 'running') {
          this.setState('running');
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error({ err: error }, 'Poll cycle failed');
        this.emitError(error);
      }

      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    const trades = await this.fetchTrades();

    for (const trade of trades) {
      // Skip trades we've already seen
      if (trade.timestamp <= this.lastSeenTimestamp) continue;

      const event = this.mapToRawEvent(trade);
      if (event) {
        this.emitTrade(event);
      }
    }

    // Update high-water mark
    if (trades.length > 0) {
      const maxTs = Math.max(...trades.map((t) => t.timestamp));
      if (maxTs > this.lastSeenTimestamp) {
        this.lastSeenTimestamp = maxTs;
      }
    }
  }

  // ─── API Client ──────────────────────────────────────────────────────

  private async fetchTrades(): Promise<ClobTrade[]> {
    const url = new URL(`${DATA_API_BASE}/trades`);
    url.searchParams.set('user', this.config.expertAddress);
    url.searchParams.set('limit', '100');

    const response = await withRetry(
      async () => {
        const res = await fetch(url.toString(), {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });

        if (res.status === 429) {
          throw new Error('Rate limited (429)');
        }

        if (!res.ok) {
          throw new Error(`Data API error: ${res.status} ${res.statusText}`);
        }

        return res.json() as Promise<ClobTrade[]>;
      },
      {
        maxAttempts: 3,
        baseDelayMs: 2_000,
        maxDelayMs: 15_000,
        label: 'clob-fetch-trades',
      }
    );

    log.debug({ count: response.length }, 'Fetched trades from Data API');
    return response;
  }

  // ─── Mapping ─────────────────────────────────────────────────────────

  /**
   * Map a CLOB trade to the canonical RawTradeEvent format.
   *
   * The Data API provides less granular data than on-chain events:
   * - No log index (we synthesize from timestamp + conditionId)
   * - No separate maker/taker amounts
   * - No fee breakdown
   */
  private mapToRawEvent(trade: ClobTrade): RawTradeEvent | null {
    if (!trade.transactionHash) {
      log.warn({ trade }, 'Trade missing transaction hash — skipping');
      return null;
    }

    // Synthesize a log index from the trade data since the Data API
    // doesn't provide one. Use a hash of conditionId + timestamp for
    // determinism across restarts.
    const syntheticLogIndex = this.syntheticLogIndex(trade);

    const event: RawTradeEvent = {
      id: buildEventId(trade.transactionHash, syntheticLogIndex),
      txHash: trade.transactionHash,
      logIndex: syntheticLogIndex,
      blockNumber: 0n, // Not available from Data API
      blockTimestamp: trade.timestamp,
      detectedAt: Date.now(),
      source: 'clob-api',
      exchange: 'ctf', // Data API doesn't distinguish; on-chain dedup resolves
      orderHash: '',
      maker: '',
      taker: this.config.expertAddress.toLowerCase(),
      makerAssetId: '0',
      takerAssetId: trade.asset || trade.conditionId,
      makerAmountFilled: 0n,
      takerAmountFilled: BigInt(Math.round(trade.size * 1e6)), // USDC 6 decimals
      fee: 0n,
      expertSide: 'taker', // Data API returns trades from the user's perspective
    };

    return event;
  }

  /**
   * Generate a deterministic synthetic log index from trade data.
   * This ensures the same CLOB trade always produces the same event ID.
   */
  private syntheticLogIndex(trade: ClobTrade): number {
    let hash = 0;
    const key = `${trade.conditionId}-${trade.timestamp}-${trade.size}-${trade.price}`;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    // Return a large positive number in the log-index range that won't
    // collide with real on-chain log indexes (which are typically < 1000)
    return 100_000 + Math.abs(hash % 900_000);
  }
}
