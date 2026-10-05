/**
 * LabelProvider seam for offline saturation — Laya checkpoint, mock, or LLM via softLabel.
 */
import { aliasesMap, layaLabelScriptsDir, scoreStep } from '@notlm-training/laya-train';
import type { SoftLabelResult, SoftLabeledScenario } from '../saturation/softLabel.js';

export type LabelCandidate = { id?: string; utterance: string };

export type LabelContext = {
  candidates: LabelCandidate[];
  flowSteps: unknown;
  intents?: unknown;
  faq?: unknown;
  productBlurb?: string;
  /** Optional map stepId → inventory guide id for goto labels. */
  guideByStep?: Record<string, string>;
};

export type LabelProvider = {
  id: string;
  labelCandidates(ctx: LabelContext): Promise<SoftLabelResult>;
};

function asSteps(flowSteps: unknown): Array<{ id?: string; keywords?: string[] }> {
  return Array.isArray(flowSteps) ? flowSteps : [];
}

function faqList(faq: unknown): Array<{ id?: string; aliases?: string[]; text?: string }> {
  return Array.isArray(faq) ? faq : [];
}

const OOD_RE =
  /\b(recipe|recipes|muffin|muffins|cookie|cookies|cake|weather|bitcoin|homework)\b/i;

/**
 * Deterministic stand-in for Laya typed decisions (CI / no checkpoint).
 */
export function createMockLayaLabeler(opts?: { id?: string }): LabelProvider {
  const id = opts?.id ?? 'laya-mock';
  return {
    id,
    async labelCandidates(ctx: LabelContext): Promise<SoftLabelResult> {
      const steps = asSteps(ctx.flowSteps);
      const aliases = aliasesMap(ctx.intents);
      const faqs = faqList(ctx.faq);
      const scenarios: SoftLabeledScenario[] = [];

      for (let i = 0; i < ctx.candidates.length; i += 1) {
        const c = ctx.candidates[i]!;
        const utterance = c.utterance.trim();
        if (!utterance) continue;

        if (OOD_RE.test(utterance)) {
          scenarios.push({
            id: c.id ?? `laya-${i + 1}`,
            utterance,
            expect: { stepId: null, rawIntent: 'refuse', faqId: null },
          });
          continue;
        }

        let bestStep: string | null = null;
        let bestScore = 0;
        for (const step of steps) {
          if (typeof step.id !== 'string') continue;
          const s = scoreStep(
            utterance,
            step.id,
            aliases[step.id] ?? [],
            Array.isArray(step.keywords) ? step.keywords : []
          );
          if (s > bestScore) {
            bestScore = s;
            bestStep = step.id;
          }
        }

        let bestFaq: string | null = null;
        let faqScore = 0;
        for (const f of faqs) {
          if (typeof f.id !== 'string') continue;
          for (const a of f.aliases ?? []) {
            if (utterance.toLowerCase().includes(a.toLowerCase())) {
              faqScore = Math.max(faqScore, 0.8);
              bestFaq = f.id;
            }
          }
        }

        if (bestFaq && faqScore >= bestScore && faqScore >= 0.75) {
          scenarios.push({
            id: c.id ?? `laya-${i + 1}`,
            utterance,
            expect: {
              stepId: null,
              rawIntent: 'faq',
              faqId: bestFaq,
              answer: faqs.find((f) => f.id === bestFaq)?.text,
            },
          });
          continue;
        }

        if (bestStep && bestScore >= 0.75) {
          const guideId = ctx.guideByStep?.[bestStep];
          scenarios.push({
            id: c.id ?? `laya-${i + 1}`,
            utterance,
            expect: {
              stepId: bestStep,
              rawIntent: `goto:${bestStep}`,
              ...(guideId ? { guideId } : {}),
            },
          });
          continue;
        }

        scenarios.push({
          id: c.id ?? `laya-${i + 1}`,
          utterance,
          expect: { stepId: null, rawIntent: 'refuse' },
        });
      }

      if (scenarios.length === 0) {
        return {
          ok: false,
          errors: ['No labeled scenarios'],
          checklist: ['Provide candidates'],
        };
      }
      return { ok: true, scenarios, raw: { provider: id } };
    },
  };
}

/**
 * Optional process bridge: runs `python -m notlm_laya_label` with JSON on stdin.
 */
export function createLayaProcessLabeler(opts: {
  checkpoint: string;
  pythonBin?: string;
  fallbackMock?: boolean;
}): LabelProvider {
  const mock = createMockLayaLabeler({ id: 'laya-mock-fallback' });
  return {
    id: 'laya',
    async labelCandidates(ctx: LabelContext): Promise<SoftLabelResult> {
      try {
        const { spawn } = await import('node:child_process');
        const payload = JSON.stringify({
          checkpoint: opts.checkpoint,
          candidates: ctx.candidates,
          flowSteps: ctx.flowSteps,
          intents: ctx.intents,
          faq: ctx.faq,
        });
        const bin = opts.pythonBin ?? process.env.NOTLM_LAYA_PYTHON ?? 'python';
        const scriptsDir = layaLabelScriptsDir();
        const text = await new Promise<string>((resolve, reject) => {
          const child = spawn(bin, ['-m', 'notlm_laya_label'], {
            env: {
              ...process.env,
              NOTLM_LAYA_CHECKPOINT: opts.checkpoint,
              PYTHONPATH: [scriptsDir, process.env.PYTHONPATH].filter(Boolean).join(
                process.platform === 'win32' ? ';' : ':'
              ),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => {
            out += String(d);
          });
          child.stderr.on('data', (d) => {
            err += String(d);
          });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code !== 0) reject(new Error(err || `laya label exit ${code}`));
            else resolve(out);
          });
          child.stdin.write(payload);
          child.stdin.end();
        });
        const parsed = JSON.parse(text) as SoftLabelResult;
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed;
        return {
          ok: false,
          errors: ['Invalid Laya labeler JSON'],
          checklist: ['Emit SoftLabelResult JSON'],
        };
      } catch (e) {
        if (opts.fallbackMock !== false) {
          return mock.labelCandidates(ctx);
        }
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          errors: [msg],
          checklist: ['Install Laya checkpoint / python module'],
        };
      }
    },
  };
}

export function resolveLabelerKind(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NOTLM_LABELER ?? 'llm').trim().toLowerCase();
}

export function createLabelerFromEnv(env: NodeJS.ProcessEnv = process.env): LabelProvider | undefined {
  const kind = resolveLabelerKind(env);
  if (kind === 'mock' || kind === 'laya-mock') {
    return createMockLayaLabeler();
  }
  if (kind === 'laya') {
    const checkpoint = env.NOTLM_LAYA_CHECKPOINT?.trim();
    if (checkpoint) {
      return createLayaProcessLabeler({
        checkpoint,
        fallbackMock: env.NOTLM_LAYA_FALLBACK_MOCK !== '0',
      });
    }
    return createMockLayaLabeler();
  }
  return undefined;
}
