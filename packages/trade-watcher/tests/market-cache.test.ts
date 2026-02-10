import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MarketCache } from '../src/normalizer/cache/market-cache.js';
import type { MarketMetadata } from '../src/normalizer/types.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function mockMetadata(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    conditionId: '0xcondition123',
    question: 'Will it rain tomorrow?',
    outcomes: ['Yes', 'No'],
    outcomePrices: ['0.65', '0.35'],
    endDate: '2026-03-01T00:00:00Z',
    clobTokenIds: ['token-yes-111', 'token-no-222'],
    liquidityNum: 50000,
    active: true,
    closed: false,
    negativeRisk: false,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MarketCache', () => {
  let cache: MarketCache;

  beforeEach(() => {
    cache = new MarketCache({ ttlMs: 5_000, maxSize: 10 });
  });

  describe('basic operations', () => {
    it('should return null for cache miss', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('should store and retrieve metadata', () => {
      const meta = mockMetadata();
      cache.set('token-yes-111', meta);

      const result = cache.get('token-yes-111');
      expect(result).not.toBeNull();
      expect(result!.question).toBe('Will it rain tomorrow?');
    });

    it('should report correct size', () => {
      expect(cache.size).toBe(0);

      cache.set('token-yes-111', mockMetadata());
      // set() also caches under the other clobTokenId
      expect(cache.size).toBe(2);
    });

    it('should clear all entries', () => {
      cache.set('token-yes-111', mockMetadata());
      expect(cache.size).toBeGreaterThan(0);

      cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe('cross-token caching', () => {
    it('should cache under all clobTokenIds for the market', () => {
      const meta = mockMetadata({
        clobTokenIds: ['token-A', 'token-B'],
      });

      cache.set('token-A', meta);

      // Should be accessible via both token IDs
      expect(cache.get('token-A')).not.toBeNull();
      expect(cache.get('token-B')).not.toBeNull();
      expect(cache.get('token-A')!.conditionId).toBe(meta.conditionId);
      expect(cache.get('token-B')!.conditionId).toBe(meta.conditionId);
    });
  });

  describe('TTL expiry', () => {
    it('should expire entries after TTL', () => {
      vi.useFakeTimers();

      const shortCache = new MarketCache({ ttlMs: 100, maxSize: 10 });
      shortCache.set('token-111', mockMetadata());

      expect(shortCache.get('token-111')).not.toBeNull();

      // Advance time past TTL
      vi.advanceTimersByTime(150);

      expect(shortCache.get('token-111')).toBeNull();

      vi.useRealTimers();
    });

    it('should return fresh entries within TTL', () => {
      vi.useFakeTimers();

      const shortCache = new MarketCache({ ttlMs: 1000, maxSize: 10 });
      shortCache.set('token-111', mockMetadata());

      vi.advanceTimersByTime(500);

      expect(shortCache.get('token-111')).not.toBeNull();

      vi.useRealTimers();
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entries when maxSize is reached', () => {
      const tinyCache = new MarketCache({ ttlMs: 60_000, maxSize: 3 });

      tinyCache.set('t1', mockMetadata({ conditionId: 'c1', clobTokenIds: ['t1'] }));
      tinyCache.set('t2', mockMetadata({ conditionId: 'c2', clobTokenIds: ['t2'] }));
      tinyCache.set('t3', mockMetadata({ conditionId: 'c3', clobTokenIds: ['t3'] }));

      expect(tinyCache.size).toBe(3);

      // Adding a 4th entry should evict the oldest (t1)
      tinyCache.set('t4', mockMetadata({ conditionId: 'c4', clobTokenIds: ['t4'] }));

      expect(tinyCache.get('t1')).toBeNull();
      expect(tinyCache.get('t4')).not.toBeNull();
    });
  });

  describe('has()', () => {
    it('should return false for missing keys', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should return true for cached keys', () => {
      cache.set('token-111', mockMetadata({ clobTokenIds: ['token-111'] }));
      expect(cache.has('token-111')).toBe(true);
    });
  });
});
