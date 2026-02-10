import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../src/store/event-store.js';
import { Deduplicator } from '../src/dedup/deduplicator.js';
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

describe('Deduplicator', () => {
  let db: Database.Database;
  let store: EventStore;
  let dedup: Deduplicator;

  beforeEach(() => {
    db = createTestDb();
    store = new EventStore(db);
    dedup = new Deduplicator(store, 100); // Small LRU for testing
  });

  afterEach(() => {
    db.close();
  });

  describe('process', () => {
    it('should accept new events', () => {
      const event = mockEvent();
      const result = dedup.process(event);

      expect(result.isNew).toBe(true);
      expect(result.eventId).toBe(event.id);
    });

    it('should reject duplicate events (LRU hit)', () => {
      const event = mockEvent();
      dedup.process(event); // First time — new
      const result = dedup.process(event); // Second time — duplicate

      expect(result.isNew).toBe(false);
      expect(result.eventId).toBe(event.id);
    });

    it('should reject duplicates via SQLite after LRU eviction', () => {
      // Create a deduplicator with LRU size of 2
      const smallDedup = new Deduplicator(store, 2);

      const event1 = mockEvent({ id: 'e1-0' });
      const event2 = mockEvent({ id: 'e2-1' });
      const event3 = mockEvent({ id: 'e3-2' });

      smallDedup.process(event1); // LRU: [e1]
      smallDedup.process(event2); // LRU: [e1, e2]
      smallDedup.process(event3); // LRU: [e2, e3] — e1 evicted

      // event1 was evicted from LRU but exists in SQLite
      const result = smallDedup.process(event1);
      expect(result.isNew).toBe(false);
    });

    it('should handle cross-source dedup (same tx from on-chain and CLOB)', () => {
      const onChainEvent = mockEvent({
        id: '0xtx-5',
        source: 'on-chain',
      });

      const clobEvent = mockEvent({
        id: '0xtx-5', // Same ID means same trade
        source: 'clob-api',
      });

      const result1 = dedup.process(onChainEvent);
      const result2 = dedup.process(clobEvent);

      expect(result1.isNew).toBe(true);
      expect(result2.isNew).toBe(false);
    });

    it('should accept different events from different sources', () => {
      const onChainEvent = mockEvent({
        id: '0xtx-5',
        source: 'on-chain',
      });

      const clobEvent = mockEvent({
        id: '0xtx-100005',
        source: 'clob-api',
      });

      expect(dedup.process(onChainEvent).isNew).toBe(true);
      expect(dedup.process(clobEvent).isNew).toBe(true);
    });
  });

  describe('metrics', () => {
    it('should track hits and misses', () => {
      const event = mockEvent();

      expect(dedup.hits).toBe(0);
      expect(dedup.misses).toBe(0);

      dedup.process(event);
      expect(dedup.hits).toBe(0);
      expect(dedup.misses).toBe(1);

      dedup.process(event);
      expect(dedup.hits).toBe(1);
      expect(dedup.misses).toBe(1);

      dedup.process(event);
      expect(dedup.hits).toBe(2);
      expect(dedup.misses).toBe(1);
    });

    it('should track cache size', () => {
      expect(dedup.cacheSize).toBe(0);

      dedup.process(mockEvent({ id: 'a-0' }));
      expect(dedup.cacheSize).toBe(1);

      dedup.process(mockEvent({ id: 'b-1' }));
      expect(dedup.cacheSize).toBe(2);

      // Duplicate shouldn't increase size
      dedup.process(mockEvent({ id: 'a-0' }));
      expect(dedup.cacheSize).toBe(2);
    });
  });

  describe('persistence guarantee', () => {
    it('should persist events to SQLite before reporting as new', () => {
      const event = mockEvent();
      const result = dedup.process(event);

      expect(result.isNew).toBe(true);
      // Verify it's actually in SQLite
      expect(store.exists(event.id)).toBe(true);
    });

    it('should still work after creating a fresh dedup with existing store data', () => {
      // First dedup inserts the event
      dedup.process(mockEvent({ id: 'persistent-0' }));

      // Simulate restart: new Deduplicator, same store
      const freshDedup = new Deduplicator(store, 100);
      const result = freshDedup.process(mockEvent({ id: 'persistent-0' }));

      // Should detect as duplicate via SQLite (not in fresh LRU)
      expect(result.isNew).toBe(false);
    });
  });
});
