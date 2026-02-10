import type { RawTradeEvent } from '../types/index.js';

// ─── Market Phase ────────────────────────────────────────────────────────────

export type MarketPhase = 'early' | 'mid' | 'late' | 'near_resolution';

// ─── Liquidity Snapshot ──────────────────────────────────────────────────────

export interface LiquiditySnapshot {
  /** Best bid price (highest buy order) */
  bestBid: number | null;
  /** Best ask price (lowest sell order) */
  bestAsk: number | null;
  /** Total USDC depth on the bid side (top 5 levels) */
  bidDepthUsdc: number | null;
  /** Total USDC depth on the ask side (top 5 levels) */
  askDepthUsdc: number | null;
  /** Spread between best ask and best bid */
  spread: number | null;
  /** Midpoint between best bid and best ask */
  midpoint: number | null;
}

// ─── Market Metadata (cached Gamma API response) ─────────────────────────────

export interface MarketMetadata {
  /** Polymarket condition ID (0x-prefixed hex) */
  conditionId: string;
  /** Human-readable market question */
  question: string;
  /** Array of outcome names, e.g. ["Yes", "No"] */
  outcomes: string[];
  /** Array of current outcome prices as strings, e.g. ["0.65", "0.35"] */
  outcomePrices: string[];
  /** Market end/resolution date (ISO string) */
  endDate: string | null;
  /** Comma-separated CLOB token IDs (on-chain asset IDs for each outcome) */
  clobTokenIds: string[];
  /** Total liquidity in the market (USDC) */
  liquidityNum: number;
  /** Whether the market is currently active */
  active: boolean;
  /** Whether the market is closed */
  closed: boolean;
  /** Whether this is a negative-risk market */
  negativeRisk: boolean;
}

/**
 * Result of resolving an on-chain token ID to a specific market and outcome.
 */
export interface ResolvedMarket {
  metadata: MarketMetadata;
  /** Which outcome within the market this token ID represents */
  outcome: string;
  /** Index of the outcome (0 = first outcome, 1 = second, etc.) */
  outcomeIndex: number;
  /** The token ID that was resolved */
  tokenId: string;
}

// ─── Decoded Trade ───────────────────────────────────────────────────────────

export interface DecodedTrade {
  side: 'BUY' | 'SELL';
  /** USDC per outcome token (0-1 range) */
  price: number;
  /** Number of outcome tokens (human-readable, divided by 1e6) */
  quantity: number;
  /** Implied probability: price for BUY, 1-price for SELL */
  impliedProbability: number;
  /** The on-chain token ID of the outcome being traded */
  outcomeTokenId: string;
  /** USDC amount (human-readable) */
  usdcAmount: number;
}

// ─── Expert Position ─────────────────────────────────────────────────────────

export interface ExpertPosition {
  /** Position size before this trade (best-effort estimate) */
  positionBefore: number;
  /** Position size after this trade */
  positionAfter: number;
}

// ─── Normalized Trade (Final Output) ─────────────────────────────────────────
// The stable schema consumed by all downstream modules (Context Analyzer, etc.)

export interface NormalizedTrade {
  /** Deterministic trade ID (= RawTradeEvent.id) */
  expertTradeId: string;
  /** Transaction hash on Polygon */
  txHash: string;
  /** Block timestamp in unix seconds */
  timestamp: number;
  /** When the watcher first detected the raw event (unix ms) */
  detectedAt: number;
  /** Polymarket condition ID */
  marketId: string;
  /** Human-readable market question */
  marketQuestion: string;
  /** Outcome name (e.g. "Yes", "No", or a named outcome) */
  outcome: string;
  /** Whether the expert bought or sold outcome tokens */
  side: 'BUY' | 'SELL';
  /** Number of outcome tokens traded (human-readable) */
  quantity: number;
  /** Price per outcome token in USDC (0-1 range) */
  price: number;
  /** Implied probability: price for BUY, 1-price for SELL */
  impliedProbability: number;
  /** Market lifecycle phase */
  marketPhase: MarketPhase;
  /** Orderbook liquidity at the time of detection */
  liquiditySnapshot: LiquiditySnapshot;
  /** Expert's position size before this trade */
  expertPositionBefore: number;
  /** Expert's position size after this trade */
  expertPositionAfter: number;
  /** Time taken to normalize this event (ms) */
  normalizationLatencyMs: number;
  /** The original raw event, preserved for auditing */
  raw: RawTradeEvent;
}

/**
 * Serializable version of NormalizedTrade for SQLite / JSON.
 * Strips the raw event's bigint fields and flattens liquidity.
 */
export interface SerializedNormalizedTrade {
  expertTradeId: string;
  txHash: string;
  timestamp: number;
  detectedAt: number;
  marketId: string;
  marketQuestion: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  impliedProbability: number;
  marketPhase: MarketPhase;
  liquiditySnapshot: LiquiditySnapshot;
  expertPositionBefore: number;
  expertPositionAfter: number;
  normalizationLatencyMs: number;
  rawEventId: string;
}

export function serializeNormalizedTrade(
  trade: NormalizedTrade
): SerializedNormalizedTrade {
  return {
    expertTradeId: trade.expertTradeId,
    txHash: trade.txHash,
    timestamp: trade.timestamp,
    detectedAt: trade.detectedAt,
    marketId: trade.marketId,
    marketQuestion: trade.marketQuestion,
    outcome: trade.outcome,
    side: trade.side,
    quantity: trade.quantity,
    price: trade.price,
    impliedProbability: trade.impliedProbability,
    marketPhase: trade.marketPhase,
    liquiditySnapshot: trade.liquiditySnapshot,
    expertPositionBefore: trade.expertPositionBefore,
    expertPositionAfter: trade.expertPositionAfter,
    normalizationLatencyMs: trade.normalizationLatencyMs,
    rawEventId: trade.raw.id,
  };
}
