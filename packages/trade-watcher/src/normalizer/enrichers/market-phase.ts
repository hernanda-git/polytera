import type { MarketPhase } from '../types.js';

/**
 * Time thresholds for market phase classification (in milliseconds).
 */
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const NEAR_RESOLUTION_THRESHOLD = 1 * MS_PER_DAY;   // < 24 hours
const LATE_THRESHOLD = 7 * MS_PER_DAY;               // < 7 days
const MID_THRESHOLD = 30 * MS_PER_DAY;               // < 30 days
// Anything >= 30 days is 'early'

/**
 * Determine the market lifecycle phase based on time remaining until resolution.
 *
 * Rules:
 *   > 30 days remaining     -> 'early'
 *   7 - 30 days remaining   -> 'mid'
 *   1 - 7 days remaining    -> 'late'
 *   < 24 hours remaining    -> 'near_resolution'
 *
 * If no end date is provided, defaults to 'early' (most conservative).
 *
 * @param endDate - Market end/resolution date (ISO string or Date)
 * @param now     - Current time (defaults to Date.now(), injectable for testing)
 */
export function computeMarketPhase(
  endDate: string | Date | null,
  now: number = Date.now()
): MarketPhase {
  if (!endDate) {
    return 'early';
  }

  const endMs = typeof endDate === 'string' ? new Date(endDate).getTime() : endDate.getTime();

  // If the date is invalid, default to 'early'
  if (isNaN(endMs)) {
    return 'early';
  }

  const remainingMs = endMs - now;

  // If already past resolution time
  if (remainingMs <= 0) {
    return 'near_resolution';
  }

  if (remainingMs < NEAR_RESOLUTION_THRESHOLD) {
    return 'near_resolution';
  }

  if (remainingMs < LATE_THRESHOLD) {
    return 'late';
  }

  if (remainingMs < MID_THRESHOLD) {
    return 'mid';
  }

  return 'early';
}
