import { EventEmitter } from 'events';
import type { RawTradeEvent, WatcherHealth, WatcherState } from '../types/index.js';

/**
 * Event map for type-safe event emission.
 */
export interface WatcherEvents {
  trade: (event: RawTradeEvent) => void;
  error: (error: Error) => void;
  stateChange: (state: WatcherState) => void;
}

/**
 * Abstract base class for all trade watchers.
 * Provides common lifecycle management and health reporting.
 */
export abstract class BaseWatcher extends EventEmitter {
  protected state: WatcherState = 'idle';
  protected lastEventAt: number | null = null;
  protected lastBlockSeen: bigint | null = null;
  protected eventsDetected = 0;
  protected errorCount = 0;
  protected startedAt: number | null = null;

  constructor(public readonly name: string) {
    super();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  // ─── Health Reporting ────────────────────────────────────────────────

  getHealth(): WatcherHealth {
    return {
      name: this.name,
      state: this.state,
      lastEventAt: this.lastEventAt,
      lastBlockSeen: this.lastBlockSeen,
      eventsDetected: this.eventsDetected,
      errors: this.errorCount,
      startedAt: this.startedAt,
    };
  }

  // ─── Protected Helpers ───────────────────────────────────────────────

  protected setState(newState: WatcherState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.emit('stateChange', newState);
  }

  protected emitTrade(event: RawTradeEvent): void {
    this.eventsDetected++;
    this.lastEventAt = Date.now();
    this.emit('trade', event);
  }

  protected emitError(error: Error): void {
    this.errorCount++;
    this.emit('error', error);
  }
}
