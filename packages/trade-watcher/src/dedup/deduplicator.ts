import type { RawTradeEvent, DeduplicationResult } from '../types/index.js';
import type { EventStore } from '../store/event-store.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ module: 'deduplicator' });

/**
 * Simple LRU cache implemented with a Map (Map preserves insertion order).
 */
class LRUCache {
  private cache: Map<string, true> = new Map();

  constructor(private maxSize: number) {}

  has(key: string): boolean {
    if (!this.cache.has(key)) return false;
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, true);
    return true;
  }

  add(key: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (first key in Map)
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, true);
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Two-layer deduplication: in-memory LRU cache (fast path) + SQLite (durable path).
 *
 * Flow:
 * 1. Check LRU cache → if hit, it's a duplicate (no I/O)
 * 2. Attempt SQLite INSERT OR IGNORE → if 0 changes, it's a duplicate
 * 3. If new, add to LRU cache and return
 *
 * Guarantees at-least-once delivery: an event is only emitted *after*
 * it has been successfully persisted to SQLite.
 */
export class Deduplicator {
  private lru: LRUCache;
  private _hits = 0;
  private _misses = 0;

  constructor(
    private store: EventStore,
    lruSize: number = 10_000
  ) {
    this.lru = new LRUCache(lruSize);
  }

  /**
   * Process an incoming event through the dedup pipeline.
   * Returns { isNew: true } only if this is a genuinely new event
   * that has been persisted to the store.
   */
  process(event: RawTradeEvent): DeduplicationResult {
    // Fast path: in-memory LRU check
    if (this.lru.has(event.id)) {
      this._hits++;
      log.trace({ id: event.id }, 'Dedup hit (LRU)');
      return { isNew: false, eventId: event.id };
    }

    // Durable path: attempt to insert into SQLite
    const isNew = this.store.insertEvent(event);

    if (!isNew) {
      // Was already in SQLite but not in LRU (e.g. after restart)
      this.lru.add(event.id);
      this._hits++;
      log.trace({ id: event.id }, 'Dedup hit (SQLite)');
      return { isNew: false, eventId: event.id };
    }

    // Genuinely new event — add to LRU
    this.lru.add(event.id);
    this._misses++;
    log.debug({ id: event.id, source: event.source }, 'New event accepted');
    return { isNew: true, eventId: event.id };
  }

  /** Total duplicate detections */
  get hits(): number {
    return this._hits;
  }

  /** Total new events accepted */
  get misses(): number {
    return this._misses;
  }

  /** Current LRU cache size */
  get cacheSize(): number {
    return this.lru.size;
  }
}
