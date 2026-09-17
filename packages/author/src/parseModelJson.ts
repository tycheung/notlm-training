import { validatePackFolder, type ValidationResult } from '@uipilot/schema';

export type ParseModelJsonOk = { ok: true; data: Record<string, unknown> };
export type ParseModelJsonFail = { ok: false; errors: string[]; checklist: string[] };
export type ParseModelJsonResult = ParseModelJsonOk | ParseModelJsonFail;

/** Strip markdown fences and extract the first JSON object/array. */
export function extractJsonText(modelText: string): string | null {
  const trimmed = modelText.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence?.[1] ?? trimmed).trim();

  const objStart = candidate.indexOf('{');
  const arrStart = candidate.indexOf('[');
  let start = -1;
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) start = objStart;
  else if (arrStart >= 0) start = arrStart;
  if (start < 0) return null;

  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

function checklistFromValidation(v: ValidationResult): string[] {
  if (v.ok) return [];
  return [
    'Fix schema validation errors before accepting draft:',
    ...v.errors.map((e) => `- ${e}`),
  ];
}

/**
 * Extract JSON from model text, then schema-validate as a pack-folder map.
 * On failure returns checklist-style errors for the author CLI.
 */
export function parseModelJson(modelText: string): ParseModelJsonResult {
  const extracted = extractJsonText(modelText);
  if (!extracted) {
    const errors = ['Could not extract a JSON object from model output'];
    return {
      ok: false,
      errors,
      checklist: ['Model did not return JSON — re-prompt asking for JSON only', ...errors],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'JSON parse failed';
    const errors = [`Invalid JSON: ${msg}`];
    return {
      ok: false,
      errors,
      checklist: ['Repair invalid JSON from the model', ...errors.map((e) => `- ${e}`)],
    };
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const errors = ['Expected a JSON object at the top level'];
    return { ok: false, errors, checklist: checklistFromValidation({ ok: false, errors }) };
  }

  const data = parsed as Record<string, unknown>;
  const validation = validatePackFolder(data);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      checklist: checklistFromValidation(validation),
    };
  }

  return { ok: true, data };
}
