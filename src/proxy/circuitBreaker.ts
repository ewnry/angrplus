export interface CircuitBreakerOptions {
  enabled?: boolean;
  failureThreshold?: number;
  cooldownMs?: number;
}
interface CircuitState {
  failures: number;
  openedAt?: number;
  probing: boolean;
}

/** One half-open probe per model; other callers use their configured fallback. */
export class CircuitBreaker {
  private readonly states = new Map<string, CircuitState>();
  constructor(private readonly now: () => number = Date.now) {}

  acquire(key: string, options: CircuitBreakerOptions = {}): boolean {
    if (options.enabled === false) return true;
    const state = this.states.get(key);
    if (!state || state.openedAt === undefined) return true;
    if (state.probing || this.now() - state.openedAt < (options.cooldownMs ?? 30_000)) return false;
    state.probing = true;
    return true;
  }

  succeed(key: string): void {
    this.states.delete(key);
  }

  fail(key: string, options: CircuitBreakerOptions = {}): void {
    if (options.enabled === false) return;
    const state = this.states.get(key) || { failures: 0, probing: false };
    state.failures += 1;
    if (state.probing || state.failures >= (options.failureThreshold ?? 3)) state.openedAt = this.now();
    state.probing = false;
    this.states.set(key, state);
  }

  cancel(key: string): void {
    const state = this.states.get(key);
    if (state) state.probing = false;
  }

  snapshot(): { tracked: number; open: number; probing: number } {
    const states = [...this.states.values()];
    return {
      tracked: states.length,
      open: states.filter((s) => s.openedAt !== undefined).length,
      probing: states.filter((s) => s.probing).length,
    };
  }
}
