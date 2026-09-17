import { readRelative, walkSourceFiles } from './walkSource.js';

const SCAN_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js']);

export type FormHit = {
  kind: 'form' | 'submit' | 'save-cta';
  file: string;
  nameHint: string;
  confidence: 'high' | 'medium' | 'low';
};

export type ScanFormsResult = {
  forms: FormHit[];
};

const FORM_TAG_RE = /<form\b/gi;
const ON_SUBMIT_RE = /\bonSubmit\s*=/g;
const TYPE_SUBMIT_RE = /\btype\s*=\s*(["'])submit\1/gi;
const SAVE_CTA_RE = /\b(Save|Submit|Create)\b/gi;

/**
 * Detect form / submit / save-cta write surfaces under `dir`.
 * Does not invent flow requires — only surfaces candidates with confidence.
 */
export function scanForms(dir: string): ScanFormsResult {
  const files = walkSourceFiles(dir, SCAN_EXTS);
  const forms: FormHit[] = [];

  for (const file of files) {
    const { rel, text } = readRelative(dir, file);

    FORM_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FORM_TAG_RE.exec(text)) !== null) {
      forms.push({
        kind: 'form',
        file: rel,
        nameHint: snippetHint(text, m.index, 'form'),
        confidence: 'high',
      });
    }

    ON_SUBMIT_RE.lastIndex = 0;
    while ((m = ON_SUBMIT_RE.exec(text)) !== null) {
      forms.push({
        kind: 'submit',
        file: rel,
        nameHint: snippetHint(text, m.index, 'onSubmit'),
        confidence: 'high',
      });
    }

    TYPE_SUBMIT_RE.lastIndex = 0;
    while ((m = TYPE_SUBMIT_RE.exec(text)) !== null) {
      forms.push({
        kind: 'submit',
        file: rel,
        nameHint: snippetHint(text, m.index, 'type=submit'),
        confidence: 'high',
      });
    }

    // Buttons / CTAs with Save|Submit|Create in surrounding window.
    const buttonLike = /<(?:button|Button)\b[^>]*>/gi;
    while ((m = buttonLike.exec(text)) !== null) {
      const start = Math.max(0, m.index - 40);
      const end = Math.min(text.length, m.index + (m[0]?.length ?? 0) + 40);
      const window = text.slice(start, end);
      SAVE_CTA_RE.lastIndex = 0;
      const cta = SAVE_CTA_RE.exec(window);
      if (!cta) continue;
      const label = cta[1] ?? 'Save';
      forms.push({
        kind: 'save-cta',
        file: rel,
        nameHint: label,
        confidence: 'medium',
      });
    }
  }

  return { forms };
}

function snippetHint(text: string, index: number, fallback: string): string {
  const start = Math.max(0, index);
  const end = Math.min(text.length, index + 80);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return slice.slice(0, 60) || fallback;
}
