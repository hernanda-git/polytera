import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ module: 'database' });

let _db: Database.Database | null = null;

/**
 * Initialize and return the SQLite database connection.
 * Creates the data directory and runs migrations on first call.
 */
export function getDatabase(dbPath: string): Database.Database {
  if (_db) return _db;

  // Ensure the data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info({ dir }, 'Created database directory');
  }

  _db = new Database(dbPath);

  // Enable WAL mode for better concurrent read/write performance
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  runMigrations(_db);
  log.info({ dbPath }, 'Database initialized');

  return _db;
}

/**
 * Close the database connection gracefully.
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info('Database connection closed');
  }
}

// ─── Migrations ──────────────────────────────────────────────────────────────

function runMigrations(db: Database.Database): void {
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

    CREATE INDEX IF NOT EXISTS idx_raw_events_tx_hash
      ON raw_events(tx_hash);

    CREATE INDEX IF NOT EXISTS idx_raw_events_block_number
      ON raw_events(block_number);

    CREATE INDEX IF NOT EXISTS idx_raw_events_detected_at
      ON raw_events(detected_at);

    CREATE INDEX IF NOT EXISTS idx_raw_events_processed_at
      ON raw_events(processed_at);

    -- Signal Normalizer: normalized trade events
    CREATE TABLE IF NOT EXISTS normalized_events (
      expert_trade_id       TEXT PRIMARY KEY,
      tx_hash               TEXT NOT NULL,
      timestamp             INTEGER NOT NULL,
      detected_at           INTEGER NOT NULL,
      market_id             TEXT NOT NULL,
      market_question       TEXT NOT NULL,
      outcome               TEXT NOT NULL,
      side                  TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
      quantity              REAL NOT NULL,
      price                 REAL NOT NULL,
      implied_probability   REAL NOT NULL,
      market_phase          TEXT NOT NULL CHECK(market_phase IN ('early', 'mid', 'late', 'near_resolution')),
      liquidity_snapshot    TEXT NOT NULL,
      expert_position_before REAL NOT NULL,
      expert_position_after  REAL NOT NULL,
      normalization_latency_ms INTEGER NOT NULL,
      raw_event_id          TEXT NOT NULL,
      created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (raw_event_id) REFERENCES raw_events(id)
    );

    CREATE INDEX IF NOT EXISTS idx_normalized_events_market_id
      ON normalized_events(market_id);

    CREATE INDEX IF NOT EXISTS idx_normalized_events_timestamp
      ON normalized_events(timestamp);
  `);

  log.debug('Migrations applied');
}
