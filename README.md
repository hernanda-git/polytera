# Polytera

Monorepo for the **Polymarket expert-signal copy trading** system. The agent observes an expert account, extracts actionable signals, and selectively copies trades under strict risk governance.

## Repository structure

| Package | Description |
|--------|-------------|
| **trade-watcher** | Real-time detection of expert trades via on-chain events (Polygon) and CLOB API. Deduplicates and persists events for downstream components. |

## Getting started

### Prerequisites

- Node.js 18+
- npm (or pnpm/yarn)

### Trade Watcher

1. **Install dependencies**

   ```bash
   cd packages/trade-watcher
   npm install
   ```

2. **Configure environment**

   Copy the example env and set your values:

   ```bash
   cp .env.example .env
   ```

   Required:

   - `POLYGON_RPC_WSS` – Polygon WebSocket RPC (e.g. Alchemy)
   - `POLYGON_RPC_HTTP` – Polygon HTTP RPC
   - `EXPERT_ADDRESS` – Wallet address to monitor

   Optional: `DB_PATH`, `LOG_LEVEL`, `CLOB_POLL_INTERVAL_MS`, `HEALTH_PORT`. See `.env.example` for details.

3. **Run**

   ```bash
   npm run dev    # development (tsx watch)
   npm run build && npm start   # production
   ```

4. **Tests**

   ```bash
   npm test
   ```

## License

MIT
