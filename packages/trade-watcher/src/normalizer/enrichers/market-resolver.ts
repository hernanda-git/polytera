import type { MarketMetadata, ResolvedMarket } from '../types.js';
import { MarketCache } from '../cache/market-cache.js';
import { withRetry } from '../../utils/retry.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ module: 'market-resolver' });

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

/**
 * Raw Gamma API market response — only the fields we need.
 */
interface GammaMarketResponse {
  id: string;
  question: string;
  conditionId: string;
  outcomes: string;           // JSON-encoded array, e.g. '["Yes","No"]'
  outcomePrices: string;      // JSON-encoded array, e.g. '["0.65","0.35"]'
  endDate: string | null;
  endDateIso: string | null;
  clobTokenIds: string;       // JSON-encoded array of token ID strings
  liquidityNum: number;
  active: boolean;
  closed: boolean;
  negRisk?: boolean;
  negRiskOther?: boolean;
  events?: Array<{ negRisk?: boolean }>;
}

/**
 * Resolves on-chain token IDs to Polymarket market metadata via the
 * Gamma API. Results are cached with TTL to avoid redundant API calls.
 */
export class MarketResolver {
  private cache: MarketCache;

  constructor(cache?: MarketCache) {
    this.cache = cache ?? new MarketCache();
  }

  /**
   * Given an on-chain token ID (from OrderFilled makerAssetId/takerAssetId),
   * resolve it to the full market metadata and the specific outcome.
   *
   * Returns null if the token ID cannot be resolved (e.g. it's '0' = USDC).
   */
  async resolve(tokenId: string): Promise<ResolvedMarket | null> {
    // Token ID '0' is USDC collateral, not an outcome token
    if (tokenId === '0') return null;

    // Check cache first
    const cached = this.cache.get(tokenId);
    if (cached) {
      return this.buildResolvedMarket(cached, tokenId);
    }

    // Fetch from Gamma API
    const metadata = await this.fetchMarketByTokenId(tokenId);
    if (!metadata) {
      log.warn({ tokenId }, 'Could not resolve token ID to market');
      return null;
    }

    // Cache the result
    this.cache.set(tokenId, metadata);

    return this.buildResolvedMarket(metadata, tokenId);
  }

  /**
   * Get the underlying cache (for health reporting).
   */
  getCache(): MarketCache {
    return this.cache;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /**
   * Reverse-lookup: given a CLOB token ID, find the market via Gamma API.
   */
  private async fetchMarketByTokenId(
    tokenId: string
  ): Promise<MarketMetadata | null> {
    try {
      const url = `${GAMMA_API_BASE}/markets?clob_token_ids=${tokenId}`;

      const response = await withRetry(
        async () => {
          const res = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
          });

          if (!res.ok) {
            throw new Error(
              `Gamma API error: ${res.status} ${res.statusText}`
            );
          }

          return res.json() as Promise<GammaMarketResponse[]>;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 1_000,
          maxDelayMs: 10_000,
          label: 'gamma-market-lookup',
        }
      );

      if (!response || response.length === 0) {
        log.debug({ tokenId }, 'No market found for token ID');
        return null;
      }

      const market = response[0]!;
      return this.parseGammaResponse(market);
    } catch (err) {
      log.error({ err, tokenId }, 'Failed to resolve token ID via Gamma API');
      return null;
    }
  }

  /**
   * Parse the Gamma API response into our internal MarketMetadata shape.
   */
  private parseGammaResponse(raw: GammaMarketResponse): MarketMetadata {
    let outcomes: string[] = [];
    let outcomePrices: string[] = [];
    let clobTokenIds: string[] = [];

    try {
      outcomes = JSON.parse(raw.outcomes || '[]');
    } catch {
      outcomes = [];
    }
    try {
      outcomePrices = JSON.parse(raw.outcomePrices || '[]');
    } catch {
      outcomePrices = [];
    }
    try {
      clobTokenIds = JSON.parse(raw.clobTokenIds || '[]');
    } catch {
      clobTokenIds = [];
    }

    const isNegRisk =
      raw.negRisk === true ||
      raw.negRiskOther === true ||
      raw.events?.some((e) => e.negRisk) === true;

    return {
      conditionId: raw.conditionId,
      question: raw.question,
      outcomes,
      outcomePrices,
      endDate: raw.endDateIso ?? raw.endDate ?? null,
      clobTokenIds,
      liquidityNum: raw.liquidityNum ?? 0,
      active: raw.active ?? false,
      closed: raw.closed ?? false,
      negativeRisk: isNegRisk,
    };
  }

  /**
   * Build a ResolvedMarket by matching the token ID to a specific outcome.
   */
  private buildResolvedMarket(
    metadata: MarketMetadata,
    tokenId: string
  ): ResolvedMarket {
    // Find which outcome this token ID corresponds to
    const outcomeIndex = metadata.clobTokenIds.indexOf(tokenId);

    let outcome: string;
    if (outcomeIndex >= 0 && outcomeIndex < metadata.outcomes.length) {
      outcome = metadata.outcomes[outcomeIndex]!;
    } else {
      // Fallback: we know the market but can't pinpoint the outcome
      outcome = 'Unknown';
      log.warn(
        { tokenId, clobTokenIds: metadata.clobTokenIds },
        'Token ID not found in clobTokenIds — outcome set to Unknown'
      );
    }

    return {
      metadata,
      outcome,
      outcomeIndex: Math.max(outcomeIndex, 0),
      tokenId,
    };
  }
}
