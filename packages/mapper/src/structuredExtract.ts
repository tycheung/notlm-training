/**
 * Never invent non-empty `requires` unless `confidence: 'low'` is set on that step.
 * Prefer `requires: []`.
 */
import { scanForms, type FormHit } from './scanForms.js';
import { scanGuideIdsInDir } from './scanGuideIds.js';
import { scanRoutes, type RouteHit } from './scanRoutes.js';

export type StructuredStep = {
  id: string;
  title: string;
  kind: 'soft' | 'hard' | 'optional' | 'conditional';
  requires: string[];
  confidence: 'high' | 'medium' | 'low';
  source?: string;
};

export type StructuredExtract = {
  generatedAt: string;
  sourceDir: string;
  screens: RouteHit[];
  writeCandidates: FormHit[];
  guideIds: string[];
  notifyStepIds: string[];
  steps: StructuredStep[];
};

export type RunStructuredExtractOptions = {
  /**
   * If true, invent linear requires between auto steps (each step gets `confidence: 'low'`).
   * Default false — prefer empty requires.
   */
  inventLinearRequires?: boolean;
};

export function runStructuredExtract(
  dir: string,
  opts?: RunStructuredExtractOptions
): StructuredExtract {
  const { guideIds, notifyStepIds } = scanGuideIdsInDir(dir);
  const { routes } = scanRoutes(dir);
  const { forms } = scanForms(dir);

  const invent = opts?.inventLinearRequires === true;
  const steps = buildSteps({ guideIds, routes, inventLinearRequires: invent });

  return {
    generatedAt: new Date().toISOString(),
    sourceDir: dir,
    screens: routes,
    writeCandidates: forms,
    guideIds,
    notifyStepIds,
    steps,
  };
}

function buildSteps(args: {
  guideIds: string[];
  routes: RouteHit[];
  inventLinearRequires: boolean;
}): StructuredStep[] {
  const steps: StructuredStep[] = [];
  const seen = new Set<string>();

  for (const gid of args.guideIds) {
    const id = slugFromGuideId(gid);
    if (seen.has(id)) continue;
    seen.add(id);
    steps.push({
      id,
      title: humanize(id),
      kind: 'soft',
      requires: [],
      confidence: 'low',
      source: gid,
    });
  }

  for (const route of args.routes) {
    const id = `screen-${slugPath(route.path)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    steps.push({
      id,
      title: route.path,
      kind: 'soft',
      requires: [],
      confidence: route.confidence === 'high' ? 'medium' : 'low',
      source: route.file,
    });
  }

  if (!args.inventLinearRequires) {
    return steps;
  }

  let prev: string | null = null;
  return steps.map((s) => {
    const requires = prev ? [prev] : [];
    prev = s.id;
    return {
      ...s,
      requires,
      confidence: 'low' as const,
    };
  });
}

/** Non-empty requires ⇒ confidence is low. */
export function assertRequiresPolicy(steps: StructuredStep[]): boolean {
  return steps.every(
    (s) => s.requires.length === 0 || s.confidence === 'low'
  );
}

function slugFromGuideId(guideId: string): string {
  return guideId.replace(/^guide-/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') ||
    'step';
}

function slugPath(path: string): string {
  const s = path
    .replace(/^\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'root';
}

function humanize(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
