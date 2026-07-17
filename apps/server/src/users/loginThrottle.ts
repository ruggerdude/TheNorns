import { createHash } from "node:crypto";

export interface LoginThrottleResult {
  allowed: boolean;
  retry_after_seconds: number;
}

/**
 * Single-instance MVP login throttle. Keys are irreversible hashes of the
 * normalized account/IP pair so the in-memory guard does not retain emails.
 */
export class LoginAttemptThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maximumFailures = 5,
    private readonly windowMs = 15 * 60 * 1_000,
  ) {
    if (!Number.isSafeInteger(maximumFailures) || maximumFailures < 1) {
      throw new Error("maximum login failures must be a positive integer");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new Error("login throttle window must be a positive integer");
    }
  }

  key(email: string, ipAddress: string): string {
    return createHash("sha256")
      .update(`${email.trim().toLowerCase()}\u0000${ipAddress}`, "utf8")
      .digest("hex");
  }

  check(key: string, at: Date): LoginThrottleResult {
    const recent = this.recent(key, at);
    if (recent.length < this.maximumFailures) {
      return { allowed: true, retry_after_seconds: 0 };
    }
    const oldest = recent[0] ?? at.getTime();
    return {
      allowed: false,
      retry_after_seconds: Math.max(1, Math.ceil((oldest + this.windowMs - at.getTime()) / 1_000)),
    };
  }

  recordFailure(key: string, at: Date): void {
    const recent = this.recent(key, at);
    recent.push(at.getTime());
    this.failures.set(key, recent);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string, at: Date): number[] {
    const threshold = at.getTime() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((value) => value > threshold);
    if (recent.length > 0) this.failures.set(key, recent);
    else this.failures.delete(key);
    return recent;
  }
}
