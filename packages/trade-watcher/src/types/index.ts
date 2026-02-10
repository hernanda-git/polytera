// ─── Raw Trade Event ─────────────────────────────────────────────────────────
// The canonical output of the Trade Watcher module.
// Every detected expert trade is normalized into this shape before emission.

export interface RawTradeEvent {
  /** Deterministic ID: `${txHash}-${logIndex}` */
  id: string;
  /** Transaction hash on Polygon */
  txHash: string;
  /** Log index within the transaction */
  logIndex: number;
  /** Block number where the trade was mined */
  blockNumber: bigint;
  /** Block timestamp in unix seconds */
  blockTimestamp: number;
  /** When the watcher first detected this event (unix ms) */
  detectedAt: number;
  /** Which data source detected this event */
  source: TradeSource;
  /** Which Polymarket exchange contract was used */
  exchange: ExchangeType;
  /** On-chain order hash */
  orderHash: string;
  /** Maker address */
  maker: string;
  /** Taker address */
  taker: string;
  /** Maker asset ID (0 = USDC collateral, otherwise = outcome token ID) */
  makerAssetId: string;
  /** Taker asset ID (0 = USDC collateral, otherwise = outcome token ID) */
  takerAssetId: string;
  /** Amount the maker filled (raw, unscaled) */
  makerAmountFilled: bigint;
  /** Amount the taker filled (raw, unscaled) */
  takerAmountFilled: bigint;
  /** Fee amount (raw, unscaled) */
  fee: bigint;
  /** Whether the expert was the maker or taker in this fill */
  expertSide: 'maker' | 'taker';
}

/**
 * Serializable version of RawTradeEvent for SQLite storage and JSON output.
 * bigint fields are stored as strings.
 */
export interface SerializedRawTradeEvent {
  id: string;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  blockTimestamp: number;
  detectedAt: number;
  source: TradeSource;
  exchange: ExchangeType;
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
  fee: string;
  expertSide: 'maker' | 'taker';
}

export type TradeSource = 'on-chain' | 'clob-api';
export type ExchangeType = 'ctf' | 'neg-risk';

// ─── Watcher Status ──────────────────────────────────────────────────────────

export type WatcherState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'reconnecting'
  | 'stopped'
  | 'failed';

export interface WatcherHealth {
  name: string;
  state: WatcherState;
  lastEventAt: number | null;
  lastBlockSeen: bigint | null;
  eventsDetected: number;
  errors: number;
  startedAt: number | null;
}

export interface OrchestratorHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  watchers: WatcherHealth[];
  totalEventsDetected: number;
  dedupHits: number;
  uptimeMs: number;
}

// ─── Deduplication ───────────────────────────────────────────────────────────

export interface DeduplicationResult {
  isNew: boolean;
  eventId: string;
}

// ─── Serialization helpers ───────────────────────────────────────────────────

export function serializeEvent(event: RawTradeEvent): SerializedRawTradeEvent {
  return {
    ...event,
    blockNumber: event.blockNumber.toString(),
    makerAmountFilled: event.makerAmountFilled.toString(),
    takerAmountFilled: event.takerAmountFilled.toString(),
    fee: event.fee.toString(),
  };
}

export function deserializeEvent(row: SerializedRawTradeEvent): RawTradeEvent {
  return {
    ...row,
    blockNumber: BigInt(row.blockNumber),
    makerAmountFilled: BigInt(row.makerAmountFilled),
    takerAmountFilled: BigInt(row.takerAmountFilled),
    fee: BigInt(row.fee),
  };
}

/**
 * Build a deterministic event ID from transaction hash and log index.
 */
export function buildEventId(txHash: string, logIndex: number): string {
  return `${txHash}-${logIndex}`;
}

// ─── Re-exports from Signal Normalizer ───────────────────────────────────────

export type {
  NormalizedTrade,
  LiquiditySnapshot,
  MarketPhase,
  MarketMetadata,
  SerializedNormalizedTrade,
} from '../normalizer/types.js';
