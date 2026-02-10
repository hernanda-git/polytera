import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../src/store/event-store.js';
import type { RawTradeEvent } from '../src/types/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_events (
      id                  TEXT PRIMARY KEY,
      tx_hash             TEXT NOT NULL,
      log_index           INTEGER NOT NULL,
      block_number        TEXT NOT NULL,
      block_timestamp     INTEGER NOT NULL,
      detected_at         INTEGER NOT NULL,
      source              TEXT NOT NULL CHECK(source IN ('on-chain', 'clob-api')),
      exchange            TEXT NOT NULL CHECK(exchange IN ('ctf', 'neg-risk')),
      order_hash          TEXT NOT NULL,
      maker               TEXT NOT NULL,
      taker               TEXT NOT NULL,
      maker_asset_id      TEXT NOT NULL,
      taker_asset_id      TEXT NOT NULL,
      maker_amount_filled TEXT NOT NULL,
      taker_amount_filled TEXT NOT NULL,
      fee                 TEXT NOT NULL,
      expert_side         TEXT NOT NULL CHECK(expert_side IN ('maker', 'taker')),
      processed_at        INTEGER DEFAULT NULL,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_raw_events_block_number
      ON raw_events(block_number);
  `);

  return db;
}

function mockEvent(overrides: Partial<RawTradeEvent> = {}): RawTradeEvent {
  return {
    id: '0xabc123-0',
    txHash: '0xabc123',
    logIndex: 0,
    blockNumber: 50_000_000n,
    blockTimestamp: 1700000000,
    detectedAt: Date.now(),
    source: 'on-chain',
    exchange: 'ctf',
    orderHash: '0xorderhash',
    maker: '0xmaker',
    taker: '0xtaker',
    makerAssetId: '0',
    takerAssetId: '123456789',
    makerAmountFilled: 1_000_000n,
    takerAmountFilled: 500_000n,
    fee: 1_000n,
    expertSide: 'maker',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('EventStore', () => {
  let db: Database.Database;
  let store: EventStore;

  beforeEach(() => {
    db = createTestDb();
    store = new EventStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('insertEvent', () => {
    it('should insert a new event and return true', () => {
      const event = mockEvent();
      const result = store.insertEvent(event);
      expect(result).toBe(true);
    });

    it('should return false for duplicate events (same id)', () => {
      const event = mockEvent();
      store.insertEvent(event);
      const result = store.insertEvent(event);
      expect(result).toBe(false);
    });

    it('should insert events with different IDs', () => {
      const event1 = mockEvent({ id: '0xabc-0', txHash: '0xabc', logIndex: 0 });
      const event2 = mockEvent({ id: '0xdef-1', txHash: '0xdef', logIndex: 1 });

      expect(store.insertEvent(event1)).toBe(true);
      expect(store.insertEvent(event2)).toBe(true);
      expect(store.getEventCount()).toBe(2);
    });

    it('should handle bigint fields correctly through serialization', () => {
      const event = mockEvent({
        blockNumber: 99_999_999n,
        makerAmountFilled: 123_456_789_012_345n,
        takerAmountFilled: 987_654_321n,
        fee: 42n,
      });

      store.insertEvent(event);
      const events = store.getUnprocessedEvents(1);
      expect(events).toHaveLength(1);
      expect(events[0]!.blockNumber).toBe(99_999_999n);
      expect(events[0]!.makerAmountFilled).toBe(123_456_789_012_345n);
      expect(events[0]!.takerAmountFilled).toBe(987_654_321n);
      expect(events[0]!.fee).toBe(42n);
    });
  });

  describe('exists', () => {
    it('should return false for non-existent events', () => {
      expect(store.exists('nonexistent')).toBe(false);
    });

    it('should return true after insertion', () => {
      const event = mockEvent();
      store.insertEvent(event);
      expect(store.exists(event.id)).toBe(true);
    });
  });

  describe('getLatestBlockNumber', () => {
    it('should return null when store is empty', () => {
      expect(store.getLatestBlockNumber()).toBeNull();
    });

    it('should return the highest block number from on-chain events', () => {
      store.insertEvent(mockEvent({ id: 'a-0', blockNumber: 100n, source: 'on-chain' }));
      store.insertEvent(mockEvent({ id: 'b-1', blockNumber: 300n, source: 'on-chain' }));
      store.insertEvent(mockEvent({ id: 'c-2', blockNumber: 200n, source: 'on-chain' }));

      expect(store.getLatestBlockNumber()).toBe(300n);
    });

    it('should ignore clob-api events', () => {
      store.insertEvent(mockEvent({ id: 'a-0', blockNumber: 500n, source: 'clob-api' }));
      store.insertEvent(mockEvent({ id: 'b-1', blockNumber: 100n, source: 'on-chain' }));

      expect(store.getLatestBlockNumber()).toBe(100n);
    });
  });

  describe('getUnprocessedEvents', () => {
    it('should return events in block order', () => {
      store.insertEvent(mockEvent({ id: 'c-2', blockNumber: 300n, logIndex: 2 }));
      store.insertEvent(mockEvent({ id: 'a-0', blockNumber: 100n, logIndex: 0 }));
      store.insertEvent(mockEvent({ id: 'b-1', blockNumber: 200n, logIndex: 1 }));

      const events = store.getUnprocessedEvents();
      expect(events).toHaveLength(3);
      expect(events[0]!.id).toBe('a-0');
      expect(events[1]!.id).toBe('b-1');
      expect(events[2]!.id).toBe('c-2');
    });

    it('should respect the limit parameter', () => {
      store.insertEvent(mockEvent({ id: 'a-0' }));
      store.insertEvent(mockEvent({ id: 'b-1' }));
      store.insertEvent(mockEvent({ id: 'c-2' }));

      const events = store.getUnprocessedEvents(2);
      expect(events).toHaveLength(2);
    });

    it('should not return processed events', () => {
      store.insertEvent(mockEvent({ id: 'a-0' }));
      store.insertEvent(mockEvent({ id: 'b-1' }));
      store.markProcessed('a-0');

      const events = store.getUnprocessedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe('b-1');
    });
  });

  describe('getEventCount', () => {
    it('should return 0 for empty store', () => {
      expect(store.getEventCount()).toBe(0);
    });

    it('should return correct count after insertions', () => {
      store.insertEvent(mockEvent({ id: 'a-0' }));
      store.insertEvent(mockEvent({ id: 'b-1' }));
      expect(store.getEventCount()).toBe(2);
    });

    it('should not double-count duplicates', () => {
      const event = mockEvent();
      store.insertEvent(event);
      store.insertEvent(event);
      expect(store.getEventCount()).toBe(1);
    });
  });
});
