import { EventEmitter } from 'events';
import type { RawTradeEvent } from '../types/index.js';
import type { NormalizedTrade } from './types.js';
import { MarketResolver } from './enrichers/market-resolver.js';
import { MarketCache } from './cache/market-cache.js';
import { decodeTrade } from './enrichers/trade-decoder.js';
import { computeMarketPhase } from './enrichers/market-phase.js';
import { fetchLiquiditySnapshot } from './enrichers/liquidity-fetcher.js';
import { fetchExpertPosition } from './enrichers/position-tracker.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ module: 'signal-normalizer' });

interface SignalNormalizerConfig {
  expertAddress: string;
}

/**
 * Signal Normalizer — Module 2 in the Polytera pipeline.
 *
 * Takes a raw `RawTradeEvent` from the Trade Watcher and produces a fully
 * enriched `NormalizedTrade` by:
 *
 * 1. Resolving the on-chain token ID to market metadata (Gamma API + cache)
 * 2. Decoding the raw amounts into side, price, quantity
 * 3. Computing the market lifecycle phase
 * 4. Fetching an orderbook liquidity snapshot (CLOB API)
 * 5. Querying the expert's position before/after (Data API)
 *
 * Steps 4 and 5 run in parallel since they are independent.
 *
 * Emits a `'normalized'` event for the Context Analyzer to consume.
 */
export class SignalNormalizer extends EventEmitter {
  private resolver: MarketResolver;
  private config: SignalNormalizerConfig;
  private _normalized = 0;
  private _errors = 0;

  constructor(config: SignalNormalizerConfig, cache?: MarketCache) {
    super();
    this.config = config;
    this.resolver = new MarketResolver(cache ?? new MarketCache());
  }

  /**
   * Normalize a raw trade event into the enriched schema.
   *
   * Returns null if the trade cannot be normalized (e.g. market not found).
   * Never throws — errors are logged and counted.
   */
  async normalize(raw: RawTradeEvent): Promise<NormalizedTrade | null> {
    const start = Date.now();

    try {
      // ── Step 1: Decode the raw trade (sync, no API calls) ──────────
      const decoded = decodeTrade(raw);

      // ── Step 2: Resolve market metadata ────────────────────────────
      const resolved = await this.resolver.resolve(decoded.outcomeTokenId);

      if (!resolved) {
        log.warn(
          { id: raw.id, tokenId: decoded.outcomeTokenId },
          'Cannot normalize — market not resolved'
        );
        this._errors++;
        return null;
      }

      // ── Step 3: Compute market phase (sync) ────────────────────────
      const marketPhase = computeMarketPhase(resolved.metadata.endDate);

      // ── Step 4 & 5: Liquidity + Position (parallel) ───────────────
      const [liquiditySnapshot, position] = await Promise.all([
        fetchLiquiditySnapshot(decoded.outcomeTokenId),
        fetchExpertPosition(
          this.config.expertAddress,
          resolved.metadata.conditionId,
          resolved.outcomeIndex,
          decoded.side,
          decoded.quantity
        ),
      ]);

      // ── Assemble the NormalizedTrade ───────────────────────────────
      const normalizationLatencyMs = Date.now() - start;

      const normalized: NormalizedTrade = {
        expertTradeId: raw.id,
        txHash: raw.txHash,
        timestamp: raw.blockTimestamp,
        detectedAt: raw.detectedAt,
        marketId: resolved.metadata.conditionId,
        marketQuestion: resolved.metadata.question,
        outcome: resolved.outcome,
        side: decoded.side,
        quantity: decoded.quantity,
        price: decoded.price,
        impliedProbability: decoded.impliedProbability,
        marketPhase,
        liquiditySnapshot,
        expertPositionBefore: position.positionBefore,
        expertPositionAfter: position.positionAfter,
        normalizationLatencyMs,
        raw,
      };

      this._normalized++;

      log.info(
        {
          id: normalized.expertTradeId,
          market: normalized.marketQuestion,
          outcome: normalized.outcome,
          side: normalized.side,
          price: normalized.price,
          quantity: normalized.quantity,
          phase: normalized.marketPhase,
          latencyMs: normalizationLatencyMs,
        },
        'Trade normalized'
      );

      // Emit for downstream modules (Context Analyzer)
      this.emit('normalized', normalized);

      return normalized;
    } catch (err) {
      this._errors++;
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(
        { err: error, rawId: raw.id },
        'Normalization failed'
      );
      return null;
    }
  }

  /** Total successfully normalized trades */
  get normalizedCount(): number {
    return this._normalized;
  }

  /** Total normalization errors */
  get errorCount(): number {
    return this._errors;
  }

  /** Access the underlying market cache for health reporting */
  get cacheSize(): number {
    return this.resolver.getCache().size;
  }
}
