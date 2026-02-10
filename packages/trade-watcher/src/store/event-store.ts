import type Database from 'better-sqlite3';
import type { RawTradeEvent, SerializedRawTradeEvent } from '../types/index.js';
import { serializeEvent, deserializeEvent } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ module: 'event-store' });

export class EventStore {
  private insertStmt: Database.Statement;
  private existsStmt: Database.Statement;
  private latestBlockStmt: Database.Statement;
  private unprocessedStmt: Database.Statement;
  private markProcessedStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO raw_events (
        id, tx_hash, log_index, block_number, block_timestamp,
        detected_at, source, exchange, order_hash, maker, taker,
        maker_asset_id, taker_asset_id, maker_amount_filled,
        taker_amount_filled, fee, expert_side
      ) VALUES (
        @id, @txHash, @logIndex, @blockNumber, @blockTimestamp,
        @detectedAt, @source, @exchange, @orderHash, @maker, @taker,
        @makerAssetId, @takerAssetId, @makerAmountFilled,
        @takerAmountFilled, @fee, @expertSide
      )
    `);

    this.existsStmt = db.prepare(
      'SELECT 1 FROM raw_events WHERE id = ? LIMIT 1'
    );

    this.latestBlockStmt = db.prepare(
      `SELECT MAX(CAST(block_number AS INTEGER)) as latest_block
       FROM raw_events
       WHERE source = 'on-chain'`
    );

    this.unprocessedStmt = db.prepare(
      `SELECT
        id,
        tx_hash             AS txHash,
        log_index           AS logIndex,
        block_number        AS blockNumber,
        block_timestamp     AS blockTimestamp,
        detected_at         AS detectedAt,
        source,
        exchange,
        order_hash          AS orderHash,
        maker,
        taker,
        maker_asset_id      AS makerAssetId,
        taker_asset_id      AS takerAssetId,
        maker_amount_filled AS makerAmountFilled,
        taker_amount_filled AS takerAmountFilled,
        fee,
        expert_side         AS expertSide
       FROM raw_events
       WHERE processed_at IS NULL
       ORDER BY block_number ASC, log_index ASC
       LIMIT ?`
    );

    this.markProcessedStmt = db.prepare(
      'UPDATE raw_events SET processed_at = ? WHERE id = ?'
    );
  }

  /**
   * Insert a raw trade event. Returns true if the event is new (inserted),
   * false if it was a duplicate (already existed).
   */
  insertEvent(event: RawTradeEvent): boolean {
    const serialized = serializeEvent(event);
    const result = this.insertStmt.run(serialized);
    const isNew = result.changes > 0;

    if (isNew) {
      log.debug({ id: event.id, source: event.source }, 'Stored new event');
    }

    return isNew;
  }

  /**
   * Check if an event already exists in the store.
   */
  exists(eventId: string): boolean {
    return this.existsStmt.get(eventId) !== undefined;
  }

  /**
   * Get the highest block number from on-chain events.
   * Used for backfill-on-restart logic.
   */
  getLatestBlockNumber(): bigint | null {
    const row = this.latestBlockStmt.get() as
      | { latest_block: number | null }
      | undefined;
    if (!row || row.latest_block === null) return null;
    return BigInt(row.latest_block);
  }

  /**
   * Get unprocessed events for downstream consumption.
   */
  getUnprocessedEvents(limit: number = 100): RawTradeEvent[] {
    const rows = this.unprocessedStmt.all(limit) as SerializedRawTradeEvent[];
    return rows.map(deserializeEvent);
  }

  /**
   * Mark an event as processed by downstream systems.
   */
  markProcessed(eventId: string): void {
    this.markProcessedStmt.run(Date.now(), eventId);
  }

  /**
   * Get total count of stored events.
   */
  getEventCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM raw_events')
      .get() as { count: number };
    return row.count;
  }
}
