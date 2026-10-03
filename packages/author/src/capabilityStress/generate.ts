/**
 * Generate distinct lane utterances via LLM preset pre-prompts, with morph fallback.
 */
import type { LlmProvider } from '@notlm/llm';
import type { PackJsonInput } from '@notlm/core';
import { normalizeUtterance } from '@notlm/core';
import {
  CAPABILITY_LANES,
  LANE_EXPECT,
  laneGeneratePrePrompt,
  type CapabilityLane,
} from './lanes.js';
import { catalogDigest } from './packLoad.js';
import { morphCasesForLane } from './morph.js';
import type { StressCase } from './score.js';

const CHUNK = 80;

function parseUtteranceLines(text: string, want: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*\d.)\]]+\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter((l) => l.length >= 3 && l.length <= 120 && !l.startsWith('{'));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = normalizeUtterance(line) || line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= want) break;
  }
  return out;
}

export async function generateLaneCases(input: {
  lane: CapabilityLane;
  pack: PackJsonInput;
  count: number;
  provider?: LlmProvider | null;
  fixture?: boolean;
  avoid?: string[];
}): Promise<StressCase[]> {
  const expect = LANE_EXPECT[input.lane];
  const productRole = input.pack.manifest?.productRole || 'product assistant';
  const digest = catalogDigest(input.pack);
  const avoid = input.avoid || [];

  if (input.fixture || !input.provider) {
    return morphCasesForLane(input.lane, input.pack, input.count);
  }

  const texts: string[] = [];
  const seen = new Set(avoid.map((a) => normalizeUtterance(a) || a.toLowerCase()));
  let guard = 0;
  while (texts.length < input.count && guard < Math.ceil(input.count / CHUNK) + 4) {
    guard += 1;
    const need = Math.min(CHUNK, input.count - texts.length);
    const prompt = laneGeneratePrePrompt({
      lane: input.lane,
      productRole,
      catalogDigest: digest,
      count: need,
      avoidSamples: [...seen].slice(-60),
    });
    try {
      const raw = await input.provider.completeChat({
        messages: [
          {
            role: 'system',
            content:
              'You generate distinct user utterances for NotLM System One stress. One utterance per line. No JSON.',
          },
          { role: 'user', content: prompt },
        ],
      });
      for (const line of parseUtteranceLines(raw, need * 2)) {
        const key = normalizeUtterance(line) || line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        texts.push(line);
        if (texts.length >= input.count) break;
      }
    } catch {
      break;
    }
  }

  if (texts.length < input.count) {
    const morph = morphCasesForLane(input.lane, input.pack, input.count - texts.length);
    for (const m of morph) {
      const key = normalizeUtterance(m.text) || m.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      texts.push(m.text);
      if (texts.length >= input.count) break;
    }
  }

  return texts.slice(0, input.count).map((text, i) => ({
    id: `${input.lane}-${i + 1}`,
    type: input.lane,
    text,
    expect: expect.expect,
    failIf: expect.failIf,
  }));
}

export async function generateFullSuite(input: {
  pack: PackJsonInput;
  perLane: number;
  provider?: LlmProvider | null;
  fixture?: boolean;
  lanes?: CapabilityLane[];
  onProgress?: (msg: string) => void;
}): Promise<StressCase[]> {
  const lanes = input.lanes || [...CAPABILITY_LANES];
  const out: StressCase[] = [];
  for (const lane of lanes) {
    input.onProgress?.(`generate lane=${lane} n=${input.perLane}`);
    const cases = await generateLaneCases({
      lane,
      pack: input.pack,
      count: input.perLane,
      provider: input.provider,
      fixture: input.fixture,
    });
    out.push(...cases);
  }
  return out;
}
