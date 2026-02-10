import type { MarketMetadata } from '../types.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ module: 'market-cache' });

interface CacheEntry {
  data: MarketMetadata;
  expiresAt: number;
}

/**
 * TTL-aware LRU cache for market metadata.
 * Keyed by on-chain token ID (asset ID from OrderFilled events).
 * Prevents redundant Gamma API calls for the same market across multiple fills.
 */
export class MarketCache {
  private cache: Map<string, CacheEntry> = new Map();
  private ttlMs: number;
  private maxSize: number;

  constructor(options: { ttlMs?: number; maxSize?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000; // 5 minutes default
    this.maxSize = options.maxSize ?? 500;
  }

  /**
   * Get cached market metadata by token ID.
   * Returns null if not found or expired.
   */
  get(tokenId: string): MarketMetadata | null {
    const entry = this.cache.get(tokenId);

    if (!entry) return null;

    // Check TTL expiry
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(tokenId);
      log.trace({ tokenId }, 'Cache entry expired');
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(tokenId);
    this.cache.set(tokenId, entry);

    return entry.data;
  }

  /**
   * Cache market metadata for a token ID.
   * If we already know the clobTokenIds for this market, we cache under
   * all of them so any future lookup for any outcome hits the cache.
   */
  set(tokenId: string, metadata: MarketMetadata): void {
    const expiresAt = Date.now() + this.ttlMs;

    // Cache under the primary token ID
    this.evictIfNeeded();
    this.cache.set(tokenId, { data: metadata, expiresAt });

    // Also cache under all known CLOB token IDs for this market
    for (const tid of metadata.clobTokenIds) {
      if (tid && tid !== tokenId) {
        this.evictIfNeeded();
        this.cache.set(tid, { data: metadata, expiresAt });
      }
    }

    log.trace(
      { tokenId, conditionId: metadata.conditionId, cacheSize: this.cache.size },
      'Cached market metadata'
    );
  }

  /**
   * Check if a token ID is cached (and not expired).
   */
  has(tokenId: string): boolean {
    return this.get(tokenId) !== null;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private evictIfNeeded(): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest (first entry in Map)
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }
}
