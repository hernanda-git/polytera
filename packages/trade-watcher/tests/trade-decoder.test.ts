import { describe, it, expect } from 'vitest';
import { decodeTrade } from '../src/normalizer/enrichers/trade-decoder.js';
import type { RawTradeEvent } from '../src/types/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function mockRaw(overrides: Partial<RawTradeEvent> = {}): RawTradeEvent {
  return {
    id: '0xabc-0',
    txHash: '0xabc',
    logIndex: 0,
    blockNumber: 50_000_000n,
    blockTimestamp: 1700000000,
    detectedAt: Date.now(),
    source: 'on-chain',
    exchange: 'ctf',
    orderHash: '0xorderhash',
    maker: '0xexpert',
    taker: '0xcounterparty',
    makerAssetId: '0',
    takerAssetId: '99999999',
    makerAmountFilled: 500_000n,   // 0.50 USDC
    takerAmountFilled: 1_000_000n, // 1.0 outcome token
    fee: 1_000n,
    expertSide: 'maker',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('decodeTrade', () => {
  describe('BUY detection', () => {
    it('should detect BUY when expert is maker paying USDC (makerAssetId=0)', () => {
      const raw = mockRaw({
        expertSide: 'maker',
        makerAssetId: '0',           // Expert gives USDC
        takerAssetId: '12345',       // Expert receives tokens
        makerAmountFilled: 650_000n, // 0.65 USDC
        takerAmountFilled: 1_000_000n, // 1.0 token
      });

      const decoded = decodeTrade(raw);

      expect(decoded.side).toBe('BUY');
      expect(decoded.outcomeTokenId).toBe('12345');
      expect(decoded.price).toBeCloseTo(0.65, 4);
      expect(decoded.quantity).toBeCloseTo(1.0, 4);
      expect(decoded.usdcAmount).toBeCloseTo(0.65, 4);
      expect(decoded.impliedProbability).toBeCloseTo(0.65, 4);
    });

    it('should detect BUY when expert is taker paying USDC (takerAssetId=0)', () => {
      const raw = mockRaw({
        expertSide: 'taker',
        makerAssetId: '12345',       // Counterparty gives tokens
        takerAssetId: '0',           // Expert gives USDC
        makerAmountFilled: 2_000_000n, // 2.0 tokens from counterparty
        takerAmountFilled: 800_000n,   // 0.80 USDC from expert
      });

      const decoded = decodeTrade(raw);

      expect(decoded.side).toBe('BUY');
      expect(decoded.outcomeTokenId).toBe('12345');
      expect(decoded.price).toBeCloseTo(0.4, 4); // 0.80 / 2.0
      expect(decoded.quantity).toBeCloseTo(2.0, 4);
      expect(decoded.usdcAmount).toBeCloseTo(0.8, 4);
    });
  });

  describe('SELL detection', () => {
    it('should detect SELL when expert is maker paying tokens (makerAssetId!=0)', () => {
      const raw = mockRaw({
        expertSide: 'maker',
        makerAssetId: '12345',         // Expert gives tokens
        takerAssetId: '0',             // Expert receives USDC
        makerAmountFilled: 5_000_000n, // 5.0 tokens
        takerAmountFilled: 3_500_000n, // 3.50 USDC
      });

      const decoded = decodeTrade(raw);

      expect(decoded.side).toBe('SELL');
      expect(decoded.outcomeTokenId).toBe('12345');
      expect(decoded.price).toBeCloseTo(0.7, 4); // 3.50 / 5.0
      expect(decoded.quantity).toBeCloseTo(5.0, 4);
      expect(decoded.usdcAmount).toBeCloseTo(3.5, 4);
      // implied probability for SELL = 1 - price
      expect(decoded.impliedProbability).toBeCloseTo(0.3, 4);
    });

    it('should detect SELL when expert is taker paying tokens (takerAssetId!=0)', () => {
      const raw = mockRaw({
        expertSide: 'taker',
        makerAssetId: '0',              // Counterparty gives USDC
        takerAssetId: '12345',          // Expert gives tokens
        makerAmountFilled: 1_200_000n,  // 1.20 USDC from counterparty
        takerAmountFilled: 3_000_000n,  // 3.0 tokens from expert
      });

      const decoded = decodeTrade(raw);

      expect(decoded.side).toBe('SELL');
      expect(decoded.outcomeTokenId).toBe('12345');
      expect(decoded.price).toBeCloseTo(0.4, 4); // 1.20 / 3.0
      expect(decoded.quantity).toBeCloseTo(3.0, 4);
    });
  });

  describe('price calculation', () => {
    it('should compute correct price for a 50c trade', () => {
      const raw = mockRaw({
        expertSide: 'maker',
        makerAssetId: '0',
        takerAssetId: '999',
        makerAmountFilled: 500_000n, // 0.50 USDC
        takerAmountFilled: 1_000_000n, // 1.0 token
      });

      const decoded = decodeTrade(raw);
      expect(decoded.price).toBeCloseTo(0.5, 6);
    });

    it('should handle very cheap tokens (1 cent)', () => {
      const raw = mockRaw({
        expertSide: 'maker',
        makerAssetId: '0',
        takerAssetId: '999',
        makerAmountFilled: 10_000n,      // 0.01 USDC
        takerAmountFilled: 1_000_000n,   // 1.0 token
      });

      const decoded = decodeTrade(raw);
      expect(decoded.price).toBeCloseTo(0.01, 4);
    });

    it('should handle expensive tokens (99 cents)', () => {
      const raw = mockRaw({
        expertSide: 'maker',
        makerAssetId: '0',
        takerAssetId: '999',
        makerAmountFilled: 990_000n,   // 0.99 USDC
        takerAmountFilled: 1_000_000n, // 1.0 token
      });

      const decoded = decodeTrade(raw);
      expect(decoded.price).toBeCloseTo(0.99, 4);
    });
  });

  describe('edge cases', () => {
    it('should handle zero token amount without crashing', () => {
      const raw = mockRaw({
        expertSide: 'maker',
        makerAssetId: '0',
        takerAssetId: '999',
        makerAmountFilled: 100_000n,
        takerAmountFilled: 0n,
      });

      const decoded = decodeTrade(raw);
      expect(decoded.price).toBe(0);
      expect(decoded.quantity).toBe(0);
    });

    it('should clamp implied probability to [0, 1]', () => {
      const raw = mockRaw({
        expertSide: 'maker',
        makerAssetId: '0',
        takerAssetId: '999',
        makerAmountFilled: 500_000n,
        takerAmountFilled: 1_000_000n,
      });

      const decoded = decodeTrade(raw);
      expect(decoded.impliedProbability).toBeGreaterThanOrEqual(0);
      expect(decoded.impliedProbability).toBeLessThanOrEqual(1);
    });

    it('should handle large token IDs as outcome tokens', () => {
      const bigTokenId =
        '71321045679252212594626385532706912750332728571942532289631379312455583992580';
      const raw = mockRaw({
        expertSide: 'maker',
        makerAssetId: '0',
        takerAssetId: bigTokenId,
        makerAmountFilled: 750_000n,
        takerAmountFilled: 1_000_000n,
      });

      const decoded = decodeTrade(raw);
      expect(decoded.outcomeTokenId).toBe(bigTokenId);
      expect(decoded.side).toBe('BUY');
    });
  });
});
