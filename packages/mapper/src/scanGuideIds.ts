/**
 * Merges discovered ids into a ControlInventory without Playwright.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { mergeInventory } from './mergeInventory.js';
import type { ControlInventory, InventoriedControl } from './types.js';

const SCAN_EXTS = new Set(['.tsx', '.jsx', '.html', '.htm']);

const GUIDE_ID_RE = /data-guide-id\s*=\s*["']([^"']+)["']/g;
const NOTIFY_RE = /notifyStepCompleted\s*\(\s*["']([^"']+)["']/g;

export type GuideIdHit = {
  guideId: string;
  file: string;
  kind: 'data-guide-id' | 'notifyStepCompleted';
};

export type ScanGuideIdsResult = {
  hits: GuideIdHit[];
  /** Unique data-guide-id values (order of first discovery). */
  guideIds: string[];
  /** Unique step ids from notifyStepCompleted(...). */
  notifyStepIds: string[];
};

function walkFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (st.isFile() && SCAN_EXTS.has(extname(name).toLowerCase())) {
      out.push(full);
    }
  }
}

function scanFile(root: string, file: string): GuideIdHit[] {
  const text = readFileSync(file, 'utf8');
  const rel = relative(root, file).replace(/\\/g, '/');
  const hits: GuideIdHit[] = [];

  GUIDE_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GUIDE_ID_RE.exec(text)) !== null) {
    const guideId = m[1]?.trim();
    if (guideId) hits.push({ guideId, file: rel, kind: 'data-guide-id' });
  }

  NOTIFY_RE.lastIndex = 0;
  while ((m = NOTIFY_RE.exec(text)) !== null) {
    const guideId = m[1]?.trim();
    if (guideId) hits.push({ guideId, file: rel, kind: 'notifyStepCompleted' });
  }

  return hits;
}

export function scanGuideIdsInDir(dir: string): ScanGuideIdsResult {
  const files: string[] = [];
  walkFiles(dir, files);
  const hits: GuideIdHit[] = [];
  for (const file of files) {
    hits.push(...scanFile(dir, file));
  }

  const guideIds: string[] = [];
  const notifyStepIds: string[] = [];
  const seenGuide = new Set<string>();
  const seenNotify = new Set<string>();
  for (const h of hits) {
    if (h.kind === 'data-guide-id') {
      if (!seenGuide.has(h.guideId)) {
        seenGuide.add(h.guideId);
        guideIds.push(h.guideId);
      }
    } else if (!seenNotify.has(h.guideId)) {
      seenNotify.add(h.guideId);
      notifyStepIds.push(h.guideId);
    }
  }

  return { hits, guideIds, notifyStepIds };
}

function hitToControl(hit: GuideIdHit): InventoriedControl {
  return {
    role: 'unknown',
    name: hit.guideId,
    selectorHint: `[data-guide-id="${hit.guideId}"]`,
    existingGuideId: hit.guideId,
    proposedGuideId: hit.guideId,
    url: '',
    landmark: hit.file,
  };
}

/** Notify-only hits omitted. */
export function guideIdHitsToInventory(
  hits: GuideIdHit[],
  opts?: { baseUrl?: string; capturedAt?: string }
): ControlInventory {
  const byId = new Map<string, InventoriedControl>();
  for (const hit of hits) {
    if (hit.kind !== 'data-guide-id') continue;
    if (byId.has(hit.guideId)) continue;
    byId.set(hit.guideId, hitToControl(hit));
  }
  return {
    capturedAt: opts?.capturedAt ?? new Date().toISOString(),
    baseUrl: opts?.baseUrl ?? '',
    controls: [...byId.values()],
  };
}

/**
 * Preserves prior `existingGuideId` values via mergeInventory; unions by adding scan rows first.
 */
export function mergeGuideIdScan(
  existing: ControlInventory | null | undefined,
  dir: string,
  opts?: { baseUrl?: string }
): ControlInventory {
  const { hits } = scanGuideIdsInDir(dir);
  const scanned = guideIdHitsToInventory(hits, {
    baseUrl: opts?.baseUrl ?? existing?.baseUrl ?? '',
  });

  const seed: ControlInventory = {
    capturedAt: scanned.capturedAt,
    baseUrl: scanned.baseUrl || existing?.baseUrl || '',
    controls: [...(existing?.controls ?? []), ...scanned.controls],
  };

  const byId = new Map<string, InventoriedControl>();
  for (const c of seed.controls) {
    const id = c.existingGuideId ?? c.proposedGuideId;
    if (!id) continue;
    const prior = byId.get(id);
    if (!prior) {
      byId.set(id, { ...c, existingGuideId: c.existingGuideId ?? id });
      continue;
    }
    byId.set(id, {
      ...prior,
      ...c,
      existingGuideId: prior.existingGuideId ?? c.existingGuideId ?? id,
      proposedGuideId: prior.proposedGuideId || c.proposedGuideId,
      selectorHint: prior.selectorHint || c.selectorHint,
      landmark: c.landmark ?? prior.landmark,
    });
  }

  const merged = mergeInventory(existing, {
    capturedAt: scanned.capturedAt,
    baseUrl: seed.baseUrl,
    controls: [...byId.values()],
  });

  return merged;
}
