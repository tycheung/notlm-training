import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attachInventoryToSteps,
  crawlHtml,
  crawlWithPlaywright,
  mergeInventory,
  type ControlInventory,
  type ControlStepMap,
} from '@notlm-training/mapper';
import {
  draftsDir,
  join,
  pathExists,
  readJsonFile,
  resolveNotlmHome,
  writeJsonFile,
} from './notlmHome.js';

export async function cmdInventoryCrawl(args: string[]): Promise<void> {
  const htmlIdx = Math.max(args.indexOf('--html'), args.indexOf('--file'));
  const urlIdx = args.indexOf('--url');
  const flagNames = new Set(['--html', '--file', '--url']);

  let htmlFile: string | undefined =
    htmlIdx >= 0 ? args[htmlIdx + 1] : undefined;
  // npm often swallows `--html`; allow bare `*.html` positional
  if (!htmlFile) {
    htmlFile = args.find((a) => /\.html?$/i.test(a) && !a.startsWith('-'));
  }

  const dir = args
    .filter((a, i) => {
      if (flagNames.has(a)) return false;
      if (i > 0 && flagNames.has(args[i - 1]!)) return false;
      if (a.startsWith('-')) return false;
      if (htmlFile && a === htmlFile) return false;
      if (urlIdx >= 0 && a === args[urlIdx + 1]) return false;
      return true;
    })
    .at(-1);

  const { home } = resolveNotlmHome(dir);

  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  let incoming: ControlInventory;
  if (htmlFile) {
    const html = readFileSync(htmlFile, 'utf8');
    incoming = crawlHtml(html, { url: htmlFile, baseUrl: htmlFile });
  } else if (urlIdx >= 0) {
    const url = args[urlIdx + 1];
    if (!url) {
      console.error('Usage: notlm-training inventory crawl --html <file> | --url <url> [dir]');
      process.exitCode = 1;
      return;
    }
    try {
      incoming = await crawlWithPlaywright(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/playwright is not installed/i.test(msg)) {
        console.warn('Playwright unavailable; fetching HTML with fetch()…');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
        const html = await res.text();
        incoming = crawlHtml(html, { url, baseUrl: url });
      } else {
        throw err;
      }
    }
  } else {
    console.error('Usage: notlm-training inventory crawl --html <file> | --url <url> [dir]');
    console.error('Tip: npm may swallow --html; use: node packages/cli/dist/cli.js inventory crawl --html <file> [dir]');
    console.error('Or pass a bare path: notlm-training inventory crawl path/to/page.html [dir]');
    process.exitCode = 1;
    return;
  }

  const invPath = join(home, 'inventory.json');
  const existing = pathExists(invPath)
    ? readJsonFile<ControlInventory>(invPath)
    : null;
  const merged = mergeInventory(existing, incoming);
  writeJsonFile(invPath, merged);
  console.log(`Wrote ${invPath} (${merged.controls.length} controls)`);
}

/**
 * `notlm-training inventory attach [dir] [--map <file>]`
 * Reads inventory.json + control-map.json (guideId→stepId) → drafts/controls-nav.json
 */
export async function cmdInventoryAttach(args: string[]): Promise<void> {
  const mapIdx = args.indexOf('--map');
  const mapFile = mapIdx >= 0 ? args[mapIdx + 1] : undefined;
  const dir = args.find((a, i) => {
    if (a.startsWith('-')) return false;
    if (mapIdx >= 0 && (i === mapIdx || i === mapIdx + 1)) return false;
    return true;
  });
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }
  const invPath = join(home, 'inventory.json');
  if (!pathExists(invPath)) {
    console.error(`Missing inventory.json in ${home} (run inventory crawl first)`);
    process.exitCode = 1;
    return;
  }
  const mapPath = mapFile ? resolve(mapFile) : join(home, 'control-map.json');
  if (!pathExists(mapPath)) {
    console.error(`Missing control map: ${mapPath} (guideId->stepId JSON object)`);
    process.exitCode = 1;
    return;
  }
  const inventory = readJsonFile<ControlInventory>(invPath);
  const map = readJsonFile<ControlStepMap>(mapPath);
  const result = attachInventoryToSteps(inventory, map);
  const outPath = join(draftsDir(home), 'controls-nav.json');
  writeJsonFile(outPath, {
    generatedAt: new Date().toISOString(),
    sourceMap: mapPath,
    ...result,
  });
  console.log(
    `Wrote ${outPath} (${result.controls.length} nav stubs` +
      (result.unmatchedGuideIds.length
        ? `, ${result.unmatchedGuideIds.length} unmatched`
        : '') +
      ')'
  );
}

