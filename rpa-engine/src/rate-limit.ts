import { ApiError } from './spec.js';

export type RatePolicy = { minDelayMs: number; maxDelayMs: number; maxPerHour: number };

/* DESIGN-DECISION: 无原始证据，自研 */
// Jitter and an hourly cap reduce account risk and help respect platform agreements.
// They do not bypass site controls or guarantee an account is safe from restrictions.
export class RateLimiter {
  private timestamps: number[] = [];
  private nextAllowedAt = 0;
  private tail = Promise.resolve();
  constructor(private policy: RatePolicy, private clock = Date.now, private random = Math.random) {
    if (![policy.minDelayMs, policy.maxDelayMs, policy.maxPerHour].every(Number.isFinite) || policy.minDelayMs < 0 || policy.maxDelayMs < policy.minDelayMs || !Number.isInteger(policy.maxPerHour) || policy.maxPerHour < 1) throw new Error('Invalid rate policy');
  }

  async take(signal: AbortSignal): Promise<void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal.aborted) throw new ApiError(409, 'OPERATION_CANCELLED', 'operation cancelled');
      const now = this.clock();
      this.timestamps = this.timestamps.filter((timestamp) => timestamp > now - 3_600_000);
      if (this.timestamps.length >= this.policy.maxPerHour) throw new ApiError(429, 'RATE_LIMITED', 'Hourly platform operation limit reached');
      const remaining = Math.max(0, this.nextAllowedAt - now);
      if (remaining) await abortableDelay(remaining, signal);
      const usedAt = this.clock();
      this.timestamps.push(usedAt);
      const jitter = this.policy.minDelayMs + this.random() * (this.policy.maxDelayMs - this.policy.minDelayMs);
      this.nextAllowedAt = usedAt + jitter;
    } finally { release(); }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new ApiError(409, 'OPERATION_CANCELLED', 'operation cancelled')); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function ratePolicyFromEnv(): RatePolicy {
  return {
    minDelayMs: Number(process.env.RPA_MIN_DELAY_MS ?? 1500),
    maxDelayMs: Number(process.env.RPA_MAX_DELAY_MS ?? 3200),
    maxPerHour: Number(process.env.RPA_MAX_PER_HOUR ?? 120)
  };
}
