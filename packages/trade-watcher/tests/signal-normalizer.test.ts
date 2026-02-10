import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalNormalizer } from '../src/normalizer/index.js';
import { MarketCache } from '../src/normalizer/cache/market-cache.js';
import type { RawTradeEvent } from '../src/types/index.js';
import type { MarketMetadata } from '../src/normalizer/types.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const EXPERT_ADDRESS = '0xd0d6053c3c37e727402d84c14069780d360993aa';
const TOKEN_YES = '71321045679252212594626385532706912750332728571942532289631379312455583992580';
const TOKEN_NO = '82432156780363323705737496643817023861443839682053643390742490423566694103691';
const CONDITION_ID = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

function mockRaw(overrides: Partial<RawTradeEvent> = {}): RawTradeEvent {
  return {
    id: '0xtxhash-5',
    txHash: '0xtxhash',
    logIndex: 5,
    blockNumber: 55_000_000n,
    blockTimestamp: 1700000000,
    detectedAt: Date.now(),
    source: 'on-chain',
    exchange: 'ctf',
    orderHash: '0xorderhash',
    maker: EXPERT_ADDRESS,
    taker: '0xcounterparty',
    makerAssetId: '0',                  // Expert pays USDC (BUY)
    takerAssetId: TOKEN_YES,            // Expert receives YES tokens
    makerAmountFilled: 650_000n,        // 0.65 USDC
    takerAmountFilled: 1_000_000n,      // 1.0 YES token
    fee: 2_000n,
    expertSide: 'maker',
    ...overrides,
  };
}

function mockMetadata(): MarketMetadata {
  return {
    conditionId: CONDITION_ID,
    question: 'Will Bitcoin reach $100k by March 2026?',
    outcomes: ['Yes', 'No'],
    outcomePrices: ['0.65', '0.35'],
    endDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(), // 20 days out -> 'mid'
    clobTokenIds: [TOKEN_YES, TOKEN_NO],
    liquidityNum: 125000,
    active: true,
    closed: false,
    negativeRisk: false,
  };
}

// ─── Mock fetch globally ─────────────────────────────────────────────────────

function mockFetch() {
  const fetchMock = vi.fn();

  // Default: Gamma API returns our mock market
  fetchMock.mockImplementation(async (urlStr: string | URL) => {
    const url = typeof urlStr === 'string' ? urlStr : urlStr.toString();

    // Gamma API — market by token ID
    if (url.includes('gamma-api.polymarket.com/markets')) {
      return {
        ok: true,
        json: async () => [
          {
            id: '12345',
            question: 'Will Bitcoin reach $100k by March 2026?',
            conditionId: CONDITION_ID,
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.65","0.35"]',
            endDateIso: new Date(
              Date.now() + 20 * 24 * 60 * 60 * 1000
            ).toISOString(),
            clobTokenIds: `["${TOKEN_YES}","${TOKEN_NO}"]`,
            liquidityNum: 125000,
            active: true,
            closed: false,
          },
        ],
      };
    }

    // CLOB API — orderbook
    if (url.includes('clob.polymarket.com/book')) {
      return {
        ok: true,
        json: async () => ({
          market: CONDITION_ID,
          asset_id: TOKEN_YES,
          bids: [
            { price: '0.64', size: '5000' },
            { price: '0.63', size: '3000' },
            { price: '0.62', size: '2000' },
          ],
          asks: [
            { price: '0.66', size: '4000' },
            { price: '0.67', size: '2500' },
            { price: '0.68', size: '1500' },
          ],
          hash: '0xhash',
          timestamp: new Date().toISOString(),
        }),
      };
    }

    // Data API — positions
    if (url.includes('data-api.polymarket.com/positions')) {
      return {
        ok: true,
        json: async () => [
          {
            proxyWallet: EXPERT_ADDRESS,
            asset: TOKEN_YES,
            conditionId: CONDITION_ID,
            size: 101.0, // position after trade (1.0 + 100 existing)
            avgPrice: 0.63,
            initialValue: 63.0,
            currentValue: 65.0,
            cashPnl: 2.0,
            percentPnl: 3.17,
            totalBought: 101.0,
            realizedPnl: 0,
            curPrice: 0.65,
            outcome: 'Yes',
            outcomeIndex: 0,
            title: 'Will Bitcoin reach $100k by March 2026?',
            endDate: new Date(
              Date.now() + 20 * 24 * 60 * 60 * 1000
            ).toISOString(),
          },
        ],
      };
    }

    // Fallback
    return { ok: false, status: 404, statusText: 'Not Found' };
  });

  return fetchMock;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SignalNormalizer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = mockFetch();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should normalize a BUY trade end-to-end', async () => {
    const normalizer = new SignalNormalizer({
      expertAddress: EXPERT_ADDRESS,
    });

    const raw = mockRaw();
    const result = await normalizer.normalize(raw);

    expect(result).not.toBeNull();
    expect(result!.expertTradeId).toBe(raw.id);
    expect(result!.txHash).toBe(raw.txHash);
    expect(result!.side).toBe('BUY');
    expect(result!.price).toBeCloseTo(0.65, 2);
    expect(result!.quantity).toBeCloseTo(1.0, 2);
    expect(result!.impliedProbability).toBeCloseTo(0.65, 2);
    expect(result!.marketQuestion).toBe('Will Bitcoin reach $100k by March 2026?');
    expect(result!.outcome).toBe('Yes');
    expect(result!.marketId).toBe(CONDITION_ID);
    expect(result!.marketPhase).toBe('mid'); // 20 days out
    expect(result!.normalizationLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should normalize a SELL trade', async () => {
    const normalizer = new SignalNormalizer({
      expertAddress: EXPERT_ADDRESS,
    });

    const raw = mockRaw({
      expertSide: 'maker',
      makerAssetId: TOKEN_YES,         // Expert gives tokens (SELL)
      takerAssetId: '0',               // Expert receives USDC
      makerAmountFilled: 2_000_000n,   // 2.0 tokens
      takerAmountFilled: 1_400_000n,   // 1.40 USDC
    });

    const result = await normalizer.normalize(raw);

    expect(result).not.toBeNull();
    expect(result!.side).toBe('SELL');
    expect(result!.price).toBeCloseTo(0.7, 2);
    expect(result!.quantity).toBeCloseTo(2.0, 2);
    expect(result!.impliedProbability).toBeCloseTo(0.3, 2); // 1 - 0.7
  });

  it('should populate liquidity snapshot from orderbook', async () => {
    const normalizer = new SignalNormalizer({
      expertAddress: EXPERT_ADDRESS,
    });

    const result = await normalizer.normalize(mockRaw());

    expect(result).not.toBeNull();
    expect(result!.liquiditySnapshot.bestBid).toBe(0.64);
    expect(result!.liquiditySnapshot.bestAsk).toBe(0.66);
    expect(result!.liquiditySnapshot.spread).toBeCloseTo(0.02, 4);
    expect(result!.liquiditySnapshot.midpoint).toBe(0.65);
    expect(result!.liquiditySnapshot.bidDepthUsdc).toBeGreaterThan(0);
    expect(result!.liquiditySnapshot.askDepthUsdc).toBeGreaterThan(0);
  });

  it('should compute expert position before/after', async () => {
    const normalizer = new SignalNormalizer({
      expertAddress: EXPERT_ADDRESS,
    });

    const result = await normalizer.normalize(mockRaw());

    expect(result).not.toBeNull();
    // API returns size=101, trade quantity=1.0, side=BUY
    // positionAfter = 101, positionBefore = 101 - 1 = 100
    expect(result!.expertPositionAfter).toBe(101);
    expect(result!.expertPositionBefore).toBe(100);
  });

  it('should emit a normalized event', async () => {
    const normalizer = new SignalNormalizer({
      expertAddress: EXPERT_ADDRESS,
    });

    const emittedEvents: unknown[] = [];
    normalizer.on('normalized', (event) => emittedEvents.push(event));

    await normalizer.normalize(mockRaw());

    expect(emittedEvents).toHaveLength(1);
  });

  it('should use cached market data on repeated normalizations', async () => {
    const cache = new MarketCache();
    const normalizer = new SignalNormalizer(
      { expertAddress: EXPERT_ADDRESS },
      cache
    );

    // First call — cache miss, hits API
    await normalizer.normalize(mockRaw({ id: 'tx1-0' }));
    const gammaCallCount = fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('gamma-api')
    ).length;

    // Second call with same token — should hit cache
    await normalizer.normalize(mockRaw({ id: 'tx2-1' }));
    const gammaCallCount2 = fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('gamma-api')
    ).length;

    // Should not have made an additional Gamma API call
    expect(gammaCallCount2).toBe(gammaCallCount);
  });

  it('should preserve the raw event in the output', async () => {
    const normalizer = new SignalNormalizer({
      expertAddress: EXPERT_ADDRESS,
    });

    const raw = mockRaw();
    const result = await normalizer.normalize(raw);

    expect(result).not.toBeNull();
    expect(result!.raw).toBe(raw);
    expect(result!.raw.id).toBe(raw.id);
  });

  it('should track counts', async () => {
    const normalizer = new SignalNormalizer({
      expertAddress: EXPERT_ADDRESS,
    });

    expect(normalizer.normalizedCount).toBe(0);
    expect(normalizer.errorCount).toBe(0);

    await normalizer.normalize(mockRaw());

    expect(normalizer.normalizedCount).toBe(1);
    expect(normalizer.errorCount).toBe(0);
  });

  it('should handle API failures gracefully', async () => {
    // Make Gamma API fail
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }) as unknown as typeof global.fetch;

    const normalizer = new SignalNormalizer({
      expertAddress: EXPERT_ADDRESS,
    });

    const result = await normalizer.normalize(mockRaw());

    // Should return null (market can't be resolved) but not throw
    expect(result).toBeNull();
    expect(normalizer.errorCount).toBe(1);
  });
});
