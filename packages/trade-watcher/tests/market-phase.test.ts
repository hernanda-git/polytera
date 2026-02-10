import { describe, it, expect } from 'vitest';
import { computeMarketPhase } from '../src/normalizer/enrichers/market-phase.js';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

describe('computeMarketPhase', () => {
  const now = new Date('2026-02-11T12:00:00Z').getTime();

  describe('early phase (>30 days remaining)', () => {
    it('should return early for 31 days out', () => {
      const endDate = new Date(now + 31 * MS_PER_DAY).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('early');
    });

    it('should return early for 90 days out', () => {
      const endDate = new Date(now + 90 * MS_PER_DAY).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('early');
    });
  });

  describe('mid phase (7-30 days remaining)', () => {
    it('should return mid for 29 days out', () => {
      const endDate = new Date(now + 29 * MS_PER_DAY).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('mid');
    });

    it('should return mid for 15 days out', () => {
      const endDate = new Date(now + 15 * MS_PER_DAY).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('mid');
    });

    it('should return mid for exactly 7 days + 1ms', () => {
      const endDate = new Date(now + 7 * MS_PER_DAY + 1).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('mid');
    });
  });

  describe('late phase (1-7 days remaining)', () => {
    it('should return late for 6 days out', () => {
      const endDate = new Date(now + 6 * MS_PER_DAY).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('late');
    });

    it('should return late for 2 days out', () => {
      const endDate = new Date(now + 2 * MS_PER_DAY).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('late');
    });

    it('should return late for exactly 1 day + 1ms', () => {
      const endDate = new Date(now + 1 * MS_PER_DAY + 1).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('late');
    });
  });

  describe('near_resolution phase (<24 hours remaining)', () => {
    it('should return near_resolution for 23 hours out', () => {
      const endDate = new Date(now + 23 * MS_PER_HOUR).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('near_resolution');
    });

    it('should return near_resolution for 1 hour out', () => {
      const endDate = new Date(now + 1 * MS_PER_HOUR).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('near_resolution');
    });

    it('should return near_resolution for 1 minute out', () => {
      const endDate = new Date(now + 60 * 1000).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('near_resolution');
    });
  });

  describe('edge cases', () => {
    it('should return near_resolution when end date has already passed', () => {
      const endDate = new Date(now - 1 * MS_PER_DAY).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('near_resolution');
    });

    it('should return near_resolution for exactly now', () => {
      const endDate = new Date(now).toISOString();
      expect(computeMarketPhase(endDate, now)).toBe('near_resolution');
    });

    it('should return early for null end date', () => {
      expect(computeMarketPhase(null, now)).toBe('early');
    });

    it('should return early for invalid date string', () => {
      expect(computeMarketPhase('not-a-date', now)).toBe('early');
    });

    it('should return early for empty string', () => {
      expect(computeMarketPhase('', now)).toBe('early');
    });

    it('should accept a Date object', () => {
      const endDate = new Date(now + 10 * MS_PER_DAY);
      expect(computeMarketPhase(endDate, now)).toBe('mid');
    });

    // Boundary: exactly 30 days is still 'mid' (< 30 days threshold not met)
    it('should return mid at exactly 30 days boundary', () => {
      const endDate = new Date(now + 30 * MS_PER_DAY).toISOString();
      // 30 days = 30 * MS_PER_DAY, which equals MID_THRESHOLD, so remaining < threshold is false
      // Since remaining === MID_THRESHOLD, it's NOT < MID_THRESHOLD, so it falls through to 'early'
      expect(computeMarketPhase(endDate, now)).toBe('early');
    });

    // Boundary: exactly 7 days is 'late'
    it('should return late at exactly 7 days boundary', () => {
      const endDate = new Date(now + 7 * MS_PER_DAY).toISOString();
      // 7 days === LATE_THRESHOLD -> not < LATE_THRESHOLD, falls to mid
      expect(computeMarketPhase(endDate, now)).toBe('mid');
    });

    // Boundary: exactly 1 day is 'near_resolution'
    it('should return near_resolution at exactly 1 day boundary', () => {
      const endDate = new Date(now + 1 * MS_PER_DAY).toISOString();
      // 1 day === NEAR_RESOLUTION_THRESHOLD -> not <, falls to late
      expect(computeMarketPhase(endDate, now)).toBe('late');
    });
  });
});
