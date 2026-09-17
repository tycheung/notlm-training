/**
 * Never invents DAG `requires` — callers decide step wiring.
 */
import { readRelative, walkSourceFiles } from './walkSource.js';

const SCAN_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js']);

export type RouteHit = {
  path: string;
  file: string;
  confidence: 'high' | 'medium' | 'low';
};

export type ScanRoutesResult = {
  routes: RouteHit[];
};

/** `<Route path="..." />` / `<Route path='...'` */
const JSX_ROUTE_PATH_RE = /<Route\b[^>]*\bpath\s*=\s*(["'])([^"']+)\1/gi;

/** Object route: `path: '...'` / `path: "..."` */
const OBJ_PATH_RE = /\bpath\s*:\s*(["'])([^"']+)\1/g;

/**
 * Recursively scan source under `dir` for route path literals.
 * Confidence:
 * - high: JSX `<Route path=…>` or path inside a file that calls `createBrowserRouter`
 * - medium: bare `path: '…'` object fields (may be non-router)
 * - low: unused (reserved; we do not invent paths)
 */
export function scanRoutes(dir: string): ScanRoutesResult {
  const files = walkSourceFiles(dir, SCAN_EXTS);
  const routes: RouteHit[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const { rel, text } = readRelative(dir, file);
    const hasCreateBrowserRouter = /\bcreateBrowserRouter\s*\(/.test(text);

    JSX_ROUTE_PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = JSX_ROUTE_PATH_RE.exec(text)) !== null) {
      const path = m[2]?.trim();
      if (!path) continue;
      pushRoute(routes, seen, { path, file: rel, confidence: 'high' });
    }

    OBJ_PATH_RE.lastIndex = 0;
    while ((m = OBJ_PATH_RE.exec(text)) !== null) {
      const path = m[2]?.trim();
      if (!path) continue;
      // Skip if this match is already covered by a nearby JSX Route (same path+file).
      const key = `${rel}::${path}`;
      if (seen.has(key)) continue;
      const confidence: RouteHit['confidence'] = hasCreateBrowserRouter
        ? 'high'
        : 'medium';
      pushRoute(routes, seen, { path, file: rel, confidence });
    }
  }

  return { routes };
}

function pushRoute(
  routes: RouteHit[],
  seen: Set<string>,
  hit: RouteHit
): void {
  const key = `${hit.file}::${hit.path}`;
  if (seen.has(key)) return;
  seen.add(key);
  routes.push(hit);
}
