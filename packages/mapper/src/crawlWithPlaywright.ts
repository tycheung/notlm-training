import { crawlHtml } from './crawlHtml.js';
import type { ControlInventory } from './types.js';

type PlaywrightChromium = {
  launch: () => Promise<{
    newPage: () => Promise<{
      goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
      content: () => Promise<string>;
    }>;
    close: () => Promise<void>;
  }>;
};

/**
 * Optional live crawl via Playwright.
 *
 * Playwright is **not** a hard dependency of `@uipilot/mapper`.
 * Install it in the host/tooling workspace when you need URL crawls:
 *
 *   npm i -D playwright
 *   npx playwright install chromium
 *
 * If Playwright is missing, this function throws with install instructions.
 * Prefer `crawlHtml` + `--html` for unit tests and CI without browsers.
 */
export async function crawlWithPlaywright(url: string): Promise<ControlInventory> {
  let chromium: PlaywrightChromium;
  try {
    const modName = 'playwright';
    const pw = (await import(modName)) as { chromium: PlaywrightChromium };
    chromium = pw.chromium;
  } catch {
    throw new Error(
      'playwright is not installed. Use crawlHtml / `uipilot-training inventory crawl --html <file>`, ' +
        'or install with: npm i -D playwright && npx playwright install chromium'
    );
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    return crawlHtml(html, { url, baseUrl: url });
  } finally {
    await browser.close();
  }
}
