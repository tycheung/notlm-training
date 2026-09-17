import { parse, type HTMLElement } from 'node-html-parser';
import { proposeGuideId } from './proposeGuideId.js';
import type { ControlInventory, CrawlHtmlOptions, InventoriedControl } from './types.js';

const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, [role="button"], [data-guide-id]';

export function crawlHtml(html: string, options: CrawlHtmlOptions = {}): ControlInventory {
  const url = options.url ?? options.baseUrl ?? '';
  const baseUrl = options.baseUrl ?? options.url ?? '';
  const root = parse(html, { comment: false });
  const seen = new Set<string>();
  const controls: InventoriedControl[] = [];

  for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
    const control = elementToControl(el, url);
    const dedupe = `${control.role}|${control.name}|${control.selectorHint}|${control.existingGuideId ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    controls.push(control);
  }

  return {
    capturedAt: new Date().toISOString(),
    baseUrl,
    controls,
  };
}

function elementToControl(el: HTMLElement, url: string): InventoriedControl {
  const tag = el.tagName.toLowerCase();
  const roleAttr = el.getAttribute('role')?.trim();
  const existingGuideId = el.getAttribute('data-guide-id')?.trim() || null;
  const role = inferRole(tag, roleAttr, el);
  const name = inferName(el, tag);
  const selectorHint = buildSelectorHint(el, tag, existingGuideId);

  return {
    role,
    name,
    selectorHint,
    existingGuideId,
    proposedGuideId: existingGuideId ?? proposeGuideId(role, name),
    url,
  };
}

function inferRole(tag: string, roleAttr: string | undefined, el: HTMLElement): string {
  if (roleAttr) return roleAttr;
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    return 'textbox';
  }
  return tag;
}

function inferName(el: HTMLElement, tag: string): string {
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;

  const labelledBy = el.getAttribute('aria-labelledby')?.trim();
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.parentNode?.querySelector?.(`#${cssEscape(id)}`)?.text?.trim())
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }

  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const placeholder = el.getAttribute('placeholder')?.trim();
    if (placeholder) return placeholder;
    const nameAttr = el.getAttribute('name')?.trim();
    if (nameAttr) return nameAttr;
    const title = el.getAttribute('title')?.trim();
    if (title) return title;
  }

  if (tag === 'img') {
    const alt = el.getAttribute('alt')?.trim();
    if (alt) return alt;
  }

  const text = collapseWs(el.text ?? '');
  if (text) return text.slice(0, 120);

  const title = el.getAttribute('title')?.trim();
  if (title) return title;

  const href = el.getAttribute('href')?.trim();
  if (href) return href;

  return tag;
}

function buildSelectorHint(
  el: HTMLElement,
  tag: string,
  existingGuideId: string | null
): string {
  if (existingGuideId) return `[data-guide-id="${existingGuideId}"]`;
  const id = el.getAttribute('id')?.trim();
  if (id) return `#${id}`;
  const testId = el.getAttribute('data-testid')?.trim();
  if (testId) return `[data-testid="${testId}"]`;
  const name = el.getAttribute('name')?.trim();
  if (name) return `${tag}[name="${name}"]`;
  const type = el.getAttribute('type')?.trim();
  if (type) return `${tag}[type="${type}"]`;
  return tag;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cssEscape(id: string): string {
  // Minimal escape for simple ids in querySelector.
  return id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}
