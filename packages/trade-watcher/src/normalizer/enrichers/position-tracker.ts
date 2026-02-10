import type { ExpertPosition } from '../types.js';
import { withRetry } from '../../utils/retry.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ module: 'position-tracker' });

const DATA_API_BASE = 'https://data-api.polymarket.com';

/**
 * Data API position response shape (one entry per outcome).
 */
interface PositionResponse {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  outcome: string;
  outcomeIndex: number;
  title: string;
  endDate: string;
}

/**
 * Default position returned when the API call fails.
 */
const UNKNOWN_POSITION: ExpertPosition = {
  positionBefore: 0,
  positionAfter: 0,
};

/**
 * Fetch the expert's current position in a market and compute before/after.
 *
 * Important nuance: The Data API returns the position *after* the on-chain trade
 * has settled. So what we get is actually "positionAfter". We derive "positionBefore"
 * by subtracting (for BUY) or adding (for SELL) the trade quantity.
 *
 * This is best-effort: there's an inherent race condition if multiple trades
 * happen in quick succession.
 *
 * @param expertAddress - Expert wallet address
 * @param conditionId   - Market condition ID
 * @param outcomeIndex  - Which outcome (0 or 1 for binary markets)
 * @param side          - Whether the expert bought or sold
 * @param quantity      - Number of tokens traded (human-readable)
 */
export async function fetchExpertPosition(
  expertAddress: string,
  conditionId: string,
  outcomeIndex: number,
  side: 'BUY' | 'SELL',
  quantity: number
): Promise<ExpertPosition> {
  try {
    const url = new URL(`${DATA_API_BASE}/positions`);
    url.searchParams.set('user', expertAddress);
    url.searchParams.set('market', conditionId);
    url.searchParams.set('sizeThreshold', '0');

    const positions = await withRetry(
      async () => {
        const res = await fetch(url.toString(), {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
        });

        if (!res.ok) {
          throw new Error(`Data API error: ${res.status} ${res.statusText}`);
        }

        return res.json() as Promise<PositionResponse[]>;
      },
      {
        maxAttempts: 2,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
        label: 'data-api-positions',
      }
    );

    // Find the position for the specific outcome
    const position = positions.find((p) => p.outcomeIndex === outcomeIndex);

    // Current size from API = positionAfter (trade already settled on-chain)
    const positionAfter = position?.size ?? 0;

    // Derive positionBefore by reversing the trade
    let positionBefore: number;
    if (side === 'BUY') {
      positionBefore = Math.max(0, positionAfter - quantity);
    } else {
      positionBefore = positionAfter + quantity;
    }

    log.debug(
      {
        conditionId,
        outcomeIndex,
        side,
        quantity,
        positionBefore: roundTo(positionBefore, 6),
        positionAfter: roundTo(positionAfter, 6),
      },
      'Expert position resolved'
    );

    return {
      positionBefore: roundTo(positionBefore, 6),
      positionAfter: roundTo(positionAfter, 6),
    };
  } catch (err) {
    log.warn(
      { err, conditionId, expertAddress },
      'Failed to fetch expert position — returning defaults'
    );
    return UNKNOWN_POSITION;
  }
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
