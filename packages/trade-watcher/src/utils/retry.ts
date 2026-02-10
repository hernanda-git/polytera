import { createChildLogger } from './logger.js';

const log = createChildLogger({ module: 'retry' });

export interface RetryOptions {
  /** Maximum number of attempts (including the first) */
  maxAttempts: number;
  /** Initial delay in milliseconds */
  baseDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Jitter factor (0-1). Adds randomness to prevent thundering herd. */
  jitter: number;
  /** Optional label for logging */
  label?: string;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.3,
};

/**
 * Execute a function with exponential backoff + jitter on failure.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {}
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === options.maxAttempts) break;

      const delay = calculateDelay(attempt, options);
      log.warn(
        {
          attempt,
          maxAttempts: options.maxAttempts,
          delayMs: delay,
          label: options.label,
          error: lastError.message,
        },
        'Retry after failure'
      );

      await sleep(delay);
    }
  }

  throw lastError!;
}

/**
 * Calculate exponential backoff delay with jitter.
 */
function calculateDelay(attempt: number, opts: RetryOptions): number {
  const exponential = opts.baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, opts.maxDelayMs);
  const jitterAmount = capped * opts.jitter * Math.random();
  return Math.floor(capped + jitterAmount);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
