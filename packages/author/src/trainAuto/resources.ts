import os from 'node:os';

export type ResourceSnapshot = {
  cpuCount: number;
  freeMem: number;
  totalMem: number;
  rss: number;
  /** Fraction of total system RAM used by this process (rss/total). */
  ramFraction: number;
};

export function snapshotResources(): ResourceSnapshot {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const rss = process.memoryUsage().rss;
  return {
    cpuCount: os.cpus().length || 1,
    freeMem,
    totalMem,
    rss,
    ramFraction: totalMem > 0 ? rss / totalMem : 0,
  };
}

/**
 * Derive worker count from CPU/RAM budgets (fractions of machine).
 * Caps by free RAM heuristic (~256MB per worker) and CPU count * maxCpu.
 */
export function deriveWorkerCount(input: {
  maxCpu: number;
  maxRam: number;
  explicitWorkers?: number;
}): number {
  if (input.explicitWorkers && input.explicitWorkers > 0) {
    return Math.max(1, Math.floor(input.explicitWorkers));
  }
  const snap = snapshotResources();
  const cpuCap = Math.max(1, Math.floor(snap.cpuCount * clamp01(input.maxCpu)));
  const budgetBytes = snap.totalMem * clamp01(input.maxRam) - snap.rss;
  const ramCap = Math.max(1, Math.floor(budgetBytes / (256 * 1024 * 1024)));
  return Math.max(1, Math.min(cpuCap, ramCap, 8));
}

export function withinBudget(input: {
  maxCpu: number;
  maxRam: number;
  /** Optional observed system CPU fraction 0..1; if omitted, only RAM is checked. */
  systemCpuFraction?: number;
}): { ok: boolean; reason?: string; snap: ResourceSnapshot } {
  const snap = snapshotResources();
  if (snap.ramFraction > clamp01(input.maxRam) + 0.05) {
    return {
      ok: false,
      reason: `RAM over budget (process rss ${(snap.ramFraction * 100).toFixed(1)}% > maxRam ${(input.maxRam * 100).toFixed(0)}%)`,
      snap,
    };
  }
  if (
    input.systemCpuFraction !== undefined &&
    input.systemCpuFraction > clamp01(input.maxCpu) + 0.05
  ) {
    return {
      ok: false,
      reason: `CPU over budget (${(input.systemCpuFraction * 100).toFixed(1)}% > maxCpu ${(input.maxCpu * 100).toFixed(0)}%)`,
      snap,
    };
  }
  return { ok: true, snap };
}

/** Run async tasks with a concurrency limit. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = Math.max(1, concurrency);
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.8;
  return Math.min(1, Math.max(0.05, x));
}
