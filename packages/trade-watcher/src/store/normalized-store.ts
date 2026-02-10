import type Database from 'better-sqlite3';
import type { NormalizedTrade } from '../normalizer/types.js';
import { serializeNormalizedTrade } from '../normalizer/types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ module: 'normalized-store' });

/**
 * Persists NormalizedTrade events to SQLite for auditing and downstream use.
 */
export class NormalizedStore {
  private insertStmt: Database.Statement;
  private countStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO normalized_events (
        expert_trade_id, tx_hash, timestamp, detected_at,
        market_id, market_question, outcome, side,
        quantity, price, implied_probability, market_phase,
        liquidity_snapshot, expert_position_before, expert_position_after,
        normalization_latency_ms, raw_event_id
      ) VALUES (
        @expertTradeId, @txHash, @timestamp, @detectedAt,
        @marketId, @marketQuestion, @outcome, @side,
        @quantity, @price, @impliedProbability, @marketPhase,
        @liquiditySnapshotJson, @expertPositionBefore, @expertPositionAfter,
        @normalizationLatencyMs, @rawEventId
      )
    `);

    this.countStmt = db.prepare(
      'SELECT COUNT(*) as count FROM normalized_events'
    );
  }

  /**
   * Persist a normalized trade. Returns true if new, false if duplicate.
   */
  insert(trade: NormalizedTrade): boolean {
    const serialized = serializeNormalizedTrade(trade);
    const result = this.insertStmt.run({
      ...serialized,
      liquiditySnapshotJson: JSON.stringify(serialized.liquiditySnapshot),
    });
    const isNew = result.changes > 0;

    if (isNew) {
      log.debug(
        { id: trade.expertTradeId, market: trade.marketQuestion },
        'Stored normalized event'
      );
    }

    return isNew;
  }

  /**
   * Get total count of stored normalized events.
   */
  getCount(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }
}
