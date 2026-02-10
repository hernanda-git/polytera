import type { LiquiditySnapshot } from '../types.js';
import { withRetry } from '../../utils/retry.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ module: 'liquidity-fetcher' });

const CLOB_API_BASE = 'https://clob.polymarket.com';

/** Number of top orderbook levels to sum for depth calculation */
const DEPTH_LEVELS = 5;

/**
 * CLOB orderbook API response shape.
 */
interface OrderbookResponse {
  market: string;
  asset_id: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  hash: string;
  timestamp: string;
}

interface OrderbookLevel {
  price: string;
  size: string;
}

/**
 * An empty liquidity snapshot returned when the orderbook fetch fails.
 * Normalization continues — liquidity is non-critical enrichment.
 */
const EMPTY_SNAPSHOT: LiquiditySnapshot = {
  bestBid: null,
  bestAsk: null,
  bidDepthUsdc: null,
  askDepthUsdc: null,
  spread: null,
  midpoint: null,
};

/**
 * Fetch the CLOB orderbook for a given token ID and compute a liquidity snapshot.
 *
 * Graceful fallback: if the fetch fails, returns a snapshot with null values
 * rather than blocking normalization. Liquidity data is useful but not essential.
 */
export async function fetchLiquiditySnapshot(
  tokenId: string
): Promise<LiquiditySnapshot> {
  if (!tokenId || tokenId === '0') {
    return EMPTY_SNAPSHOT;
  }

  try {
    const url = `${CLOB_API_BASE}/book?token_id=${tokenId}`;

    const book = await withRetry(
      async () => {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
        });

        if (!res.ok) {
          throw new Error(`CLOB API error: ${res.status} ${res.statusText}`);
        }

        return res.json() as Promise<OrderbookResponse>;
      },
      {
        maxAttempts: 2,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
        label: 'clob-orderbook',
      }
    );

    return parseOrderbook(book);
  } catch (err) {
    log.warn(
      { err, tokenId },
      'Failed to fetch orderbook — returning empty liquidity snapshot'
    );
    return EMPTY_SNAPSHOT;
  }
}

/**
 * Parse raw orderbook data into a LiquiditySnapshot.
 */
function parseOrderbook(book: OrderbookResponse): LiquiditySnapshot {
  const bids = book.bids ?? [];
  const asks = book.asks ?? [];

  // Bids are sorted descending (highest first)
  // Asks are sorted ascending (lowest first)
  const bestBid = bids.length > 0 ? parseFloat(bids[0]!.price) : null;
  const bestAsk = asks.length > 0 ? parseFloat(asks[0]!.price) : null;

  // Compute depth: sum of (price * size) for top N levels
  const bidDepthUsdc = computeDepth(bids.slice(0, DEPTH_LEVELS));
  const askDepthUsdc = computeDepth(asks.slice(0, DEPTH_LEVELS));

  // Spread and midpoint
  let spread: number | null = null;
  let midpoint: number | null = null;

  if (bestBid !== null && bestAsk !== null) {
    spread = roundTo(bestAsk - bestBid, 6);
    midpoint = roundTo((bestBid + bestAsk) / 2, 6);
  }

  return {
    bestBid,
    bestAsk,
    bidDepthUsdc: bidDepthUsdc !== null ? roundTo(bidDepthUsdc, 2) : null,
    askDepthUsdc: askDepthUsdc !== null ? roundTo(askDepthUsdc, 2) : null,
    spread,
    midpoint,
  };
}

/**
 * Sum the USDC depth across orderbook levels: price * size for each level.
 */
function computeDepth(levels: OrderbookLevel[]): number | null {
  if (levels.length === 0) return null;

  let total = 0;
  for (const level of levels) {
    const price = parseFloat(level.price);
    const size = parseFloat(level.size);
    if (!isNaN(price) && !isNaN(size)) {
      total += price * size;
    }
  }

  return total;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
