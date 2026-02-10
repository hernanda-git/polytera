import type { RawTradeEvent } from '../../types/index.js';
import type { DecodedTrade } from '../types.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ module: 'trade-decoder' });

/**
 * USDC on Polygon has 6 decimal places.
 * Polymarket outcome tokens also use 6 decimal places (CTF standard).
 */
const DECIMALS = 6;
const SCALE = 10 ** DECIMALS;

/**
 * Decode a raw OrderFilled event into a human-readable trade.
 *
 * The key insight: in an OrderFilled event, one side pays USDC (asset ID = 0)
 * and the other side pays outcome tokens (asset ID = large number).
 *
 * Rules:
 * - Expert is MAKER:
 *   - makerAssetId === '0'  -> Expert pays USDC -> BUY outcome tokens
 *   - makerAssetId !== '0'  -> Expert pays tokens -> SELL outcome tokens
 * - Expert is TAKER:
 *   - takerAssetId === '0'  -> Expert pays USDC -> BUY outcome tokens
 *   - takerAssetId !== '0'  -> Expert pays tokens -> SELL outcome tokens
 */
export function decodeTrade(raw: RawTradeEvent): DecodedTrade {
  const isMaker = raw.expertSide === 'maker';

  // Determine which asset the expert is giving (paying) and receiving
  const expertGivesAssetId = isMaker ? raw.makerAssetId : raw.takerAssetId;
  const expertGivesAmount = isMaker
    ? raw.makerAmountFilled
    : raw.takerAmountFilled;
  const expertReceivesAssetId = isMaker ? raw.takerAssetId : raw.makerAssetId;
  const expertReceivesAmount = isMaker
    ? raw.takerAmountFilled
    : raw.makerAmountFilled;

  // Expert pays USDC (asset '0') -> they are BUYING outcome tokens
  const isBuying = expertGivesAssetId === '0';

  let usdcAmount: bigint;
  let tokenAmount: bigint;
  let outcomeTokenId: string;

  if (isBuying) {
    // Expert gives USDC, receives outcome tokens
    usdcAmount = expertGivesAmount;
    tokenAmount = expertReceivesAmount;
    outcomeTokenId = expertReceivesAssetId;
  } else {
    // Expert gives outcome tokens, receives USDC
    tokenAmount = expertGivesAmount;
    usdcAmount = expertReceivesAmount;
    outcomeTokenId = expertGivesAssetId;
  }

  // Convert to human-readable
  const usdcHuman = Number(usdcAmount) / SCALE;
  const tokenHuman = Number(tokenAmount) / SCALE;

  // Price = USDC per outcome token
  // Guard against division by zero
  const price = tokenHuman > 0 ? usdcHuman / tokenHuman : 0;

  // Implied probability
  const impliedProbability = isBuying ? price : 1 - price;

  const decoded: DecodedTrade = {
    side: isBuying ? 'BUY' : 'SELL',
    price: roundTo(price, 6),
    quantity: roundTo(tokenHuman, 6),
    impliedProbability: roundTo(clamp(impliedProbability, 0, 1), 6),
    outcomeTokenId,
    usdcAmount: roundTo(usdcHuman, 6),
  };

  log.debug(
    {
      id: raw.id,
      expertSide: raw.expertSide,
      side: decoded.side,
      price: decoded.price,
      quantity: decoded.quantity,
      usdcAmount: decoded.usdcAmount,
    },
    'Trade decoded'
  );

  return decoded;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
