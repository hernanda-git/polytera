import { describe, it, expect } from 'vitest';
import {
  buildEventId,
  serializeEvent,
  deserializeEvent,
} from '../src/types/index.js';
import type { RawTradeEvent, SerializedRawTradeEvent } from '../src/types/index.js';
import {
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  ORDER_FILLED_ABI,
} from '../src/config/contracts.js';

// ─── Type & Serialization Tests ──────────────────────────────────────────────

describe('Types and Serialization', () => {
  const sampleEvent: RawTradeEvent = {
    id: '0xabcdef1234567890-42',
    txHash: '0xabcdef1234567890',
    logIndex: 42,
    blockNumber: 50_123_456n,
    blockTimestamp: 1700000000,
    detectedAt: 1700000001000,
    source: 'on-chain',
    exchange: 'ctf',
    orderHash: '0xorderhash123',
    maker: '0xd0d6053c3c37e727402d84c14069780d360993aa',
    taker: '0x1234567890abcdef1234567890abcdef12345678',
    makerAssetId: '0',
    takerAssetId: '71321045679252212594626385532706912750332728571942532289631379312455583992580',
    makerAmountFilled: 5_000_000n,
    takerAmountFilled: 10_000_000n,
    fee: 25_000n,
    expertSide: 'maker',
  };

  describe('buildEventId', () => {
    it('should create deterministic IDs from txHash and logIndex', () => {
      expect(buildEventId('0xabc', 0)).toBe('0xabc-0');
      expect(buildEventId('0xdef', 42)).toBe('0xdef-42');
    });

    it('should produce different IDs for different log indexes', () => {
      const id1 = buildEventId('0xsame', 0);
      const id2 = buildEventId('0xsame', 1);
      expect(id1).not.toBe(id2);
    });
  });

  describe('serializeEvent', () => {
    it('should convert bigint fields to strings', () => {
      const serialized = serializeEvent(sampleEvent);

      expect(typeof serialized.blockNumber).toBe('string');
      expect(typeof serialized.makerAmountFilled).toBe('string');
      expect(typeof serialized.takerAmountFilled).toBe('string');
      expect(typeof serialized.fee).toBe('string');

      expect(serialized.blockNumber).toBe('50123456');
      expect(serialized.makerAmountFilled).toBe('5000000');
      expect(serialized.takerAmountFilled).toBe('10000000');
      expect(serialized.fee).toBe('25000');
    });

    it('should preserve non-bigint fields unchanged', () => {
      const serialized = serializeEvent(sampleEvent);

      expect(serialized.id).toBe(sampleEvent.id);
      expect(serialized.txHash).toBe(sampleEvent.txHash);
      expect(serialized.logIndex).toBe(sampleEvent.logIndex);
      expect(serialized.source).toBe(sampleEvent.source);
      expect(serialized.exchange).toBe(sampleEvent.exchange);
      expect(serialized.expertSide).toBe(sampleEvent.expertSide);
    });
  });

  describe('deserializeEvent', () => {
    it('should convert string fields back to bigint', () => {
      const serialized = serializeEvent(sampleEvent);
      const deserialized = deserializeEvent(serialized);

      expect(deserialized.blockNumber).toBe(50_123_456n);
      expect(deserialized.makerAmountFilled).toBe(5_000_000n);
      expect(deserialized.takerAmountFilled).toBe(10_000_000n);
      expect(deserialized.fee).toBe(25_000n);
    });

    it('should roundtrip correctly', () => {
      const roundtripped = deserializeEvent(serializeEvent(sampleEvent));

      expect(roundtripped.id).toBe(sampleEvent.id);
      expect(roundtripped.blockNumber).toBe(sampleEvent.blockNumber);
      expect(roundtripped.makerAmountFilled).toBe(sampleEvent.makerAmountFilled);
      expect(roundtripped.takerAmountFilled).toBe(sampleEvent.takerAmountFilled);
      expect(roundtripped.fee).toBe(sampleEvent.fee);
      expect(roundtripped.expertSide).toBe(sampleEvent.expertSide);
    });

    it('should handle very large bigint values', () => {
      const bigEvent = {
        ...sampleEvent,
        makerAmountFilled: 999_999_999_999_999_999n,
      };

      const roundtripped = deserializeEvent(serializeEvent(bigEvent));
      expect(roundtripped.makerAmountFilled).toBe(999_999_999_999_999_999n);
    });
  });
});

// ─── Contract Config Tests ───────────────────────────────────────────────────

describe('Contract Config', () => {
  it('should have valid contract addresses', () => {
    expect(CTF_EXCHANGE_ADDRESS).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(NEG_RISK_CTF_EXCHANGE_ADDRESS).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('should have different addresses for CTF and NegRisk exchanges', () => {
    expect(CTF_EXCHANGE_ADDRESS).not.toBe(NEG_RISK_CTF_EXCHANGE_ADDRESS);
  });

  it('should have OrderFilled ABI with correct event structure', () => {
    expect(ORDER_FILLED_ABI).toHaveLength(1);

    const eventAbi = ORDER_FILLED_ABI[0];
    expect(eventAbi.type).toBe('event');
    expect(eventAbi.name).toBe('OrderFilled');

    const inputNames = eventAbi.inputs.map((i) => i.name);
    expect(inputNames).toContain('orderHash');
    expect(inputNames).toContain('maker');
    expect(inputNames).toContain('taker');
    expect(inputNames).toContain('makerAssetId');
    expect(inputNames).toContain('takerAssetId');
    expect(inputNames).toContain('makerAmountFilled');
    expect(inputNames).toContain('takerAmountFilled');
    expect(inputNames).toContain('fee');
  });

  it('should have maker, taker, and orderHash as indexed params', () => {
    const eventAbi = ORDER_FILLED_ABI[0];
    const indexed = eventAbi.inputs.filter((i) => i.indexed);
    const indexedNames = indexed.map((i) => i.name);

    expect(indexedNames).toContain('orderHash');
    expect(indexedNames).toContain('maker');
    expect(indexedNames).toContain('taker');
    expect(indexed).toHaveLength(3);
  });
});
