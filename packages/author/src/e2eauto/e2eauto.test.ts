import { mkdtempSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPackJsonFromFolder, resolvePackFolder } from '../capabilityStress/packLoad.js';
import { evaluateUtterance, loadE2ePack } from './evaluate.js';
import { gradeOutcome } from './grade.js';
import { loadE2eCases } from './loadCases.js';
import type { LlmProvider } from '@notlm-training/llm';
import { applyLesson, collidingFaqAliases, proposeLessonPatch } from './learn.js';
import { runE2eAutoLoop } from './loop.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../');
const fixtureRoot = join(repoRoot, 'fixtures/e2eauto-pack/.notlm');
const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('e2eauto evaluate/grade/learn', () => {
  it('grades known FAQ Correct and missing alias as learnable miss', () => {
    const packDir = resolvePackFolder(fixtureRoot);
    const pack = loadPackJsonFromFolder(packDir);
    const loaded = loadE2ePack(pack);

    const ok = evaluateUtterance('How many byes can a bracket have?', loaded);
    const gOk = gradeOutcome(
      {
        id: 'ok',
        utterance: 'How many byes can a bracket have?',
        expect: { faqId: 'faq-bracket-byes' },
        source: 't',
      },
      ok
    );
    expect(gOk.grade).toBe('Correct');
    expect(gOk.needsLearn).toBe(false);

    const miss = evaluateUtterance('What is Max 300?', loaded);
    const gMiss = gradeOutcome(
      {
        id: 'miss',
        utterance: 'What is Max 300?',
        expect: { faqId: 'faq-max-300' },
        source: 't',
      },
      miss
    );
    expect(['Wrong', 'NoReply', 'Partly', 'LayaRisk']).toContain(gMiss.grade);
    expect(gMiss.needsLearn).toBe(true);

    const { applied } = applyLesson(pack, gMiss);
    expect(applied).toBe(true);
    const after = evaluateUtterance('What is Max 300?', loadE2ePack(pack));
    expect(after.strongFaqId).toBe('faq-max-300');
  });

  it('lesson strips FAQ aliases that steal a step expect', () => {
    const packDir = resolvePackFolder(fixtureRoot);
    const pack = loadPackJsonFromFolder(packDir);
    pack.faq = [
      ...(pack.faq || []),
      {
        id: 'faq-scoring',
        aliases: ['start scores wont open', 'how does scoring work'],
        text: 'scoring faq',
      },
    ];
    pack.intents = {
      ...(pack.intents || {}),
      aliases: { ...(pack.intents?.aliases || {}), enter_scores: [] },
    };
    const utterance = 'please bro start scores wont open what am i missing help?';
    const graded = {
      case: {
        id: 'steal',
        utterance,
        expect: { stepId: 'enter_scores' },
        source: 't',
      },
      outcome: {
        strongFaqId: 'faq-scoring',
        weakFaqId: 'faq-scoring',
        stepId: null,
        rawIntent: 'faq',
        ood: false,
        explainLast: false,
        contextAsk: false,
        replyStub: 'scoring faq',
      },
      grade: 'Partly' as const,
      reasons: ['wanted step; got FAQ faq-scoring'],
      needsLearn: true,
    };
    const steal = (pack.faq || []).find((f) => f.id === 'faq-scoring');
    expect(collidingFaqAliases(steal, utterance).length).toBeGreaterThan(0);
    const { applied, patch } = applyLesson(pack, graded);
    expect(applied).toBe(true);
    expect(patch.faqRemoveAliases?.[0]?.id).toBe('faq-scoring');
    const after = (pack.faq || []).find((f) => f.id === 'faq-scoring');
    expect(after?.aliases.some((a) => /start scores wont open/i.test(a))).toBe(
      false
    );
  });

  it('proposeLessonPatch uses injected LLM JSON when fixture=false', async () => {
    const packDir = resolvePackFolder(fixtureRoot);
    const pack = loadPackJsonFromFolder(packDir);
    const loaded = loadE2ePack(pack);
    const miss = evaluateUtterance('alias only for llm path please', loaded);
    const graded = gradeOutcome(
      {
        id: 'llm-miss',
        utterance: 'alias only for llm path please',
        expect: { faqId: 'faq-max-300' },
        source: 't',
      },
      miss
    );
    const provider: LlmProvider = {
      async completeChat() {
        return JSON.stringify({
          faq: [{ id: 'faq-max-300', aliases: ['alias only for llm path please'] }],
          notes: 'from-mock-llm',
        });
      },
    };
    const patch = await proposeLessonPatch({
      pack,
      graded,
      provider,
      fixture: false,
    });
    expect(patch.notes).toBe('from-mock-llm');
    expect(patch.faq?.[0]?.id).toBe('faq-max-300');
  });

  it('loop checkpoints and learns until miss is Correct', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e2eauto-'));
    temps.push(root);
    const home = join(root, '.notlm');
    cpSync(fixtureRoot, home, { recursive: true });
    const packDir = resolvePackFolder(home);
    const pack = loadPackJsonFromFolder(packDir);
    const cases = loadE2eCases(home, ['faq-scenarios.json']);
    expect(cases.length).toBeGreaterThanOrEqual(3);

    const report = await runE2eAutoLoop({
      home,
      packDir,
      pack,
      cases,
      config: {
        fixture: true,
        writePack: true,
        reshuffle: false,
        maxRounds: 40,
        maxLessons: 10,
        checkpointEvery: 1,
      },
    });

    expect(report.lessons).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(home, 'train-e2eauto', 'report.json'))).toBe(true);
    expect(existsSync(join(home, 'train-e2eauto', 'state.json'))).toBe(true);
    const ck = join(home, 'train-e2eauto', 'checkpoint');
    expect(existsSync(ck)).toBe(true);

    const faq = JSON.parse(
      readFileSync(join(packDir, 'faq.json'), 'utf8')
    ) as Array<{ id: string; aliases: string[] }>;
    const max = faq.find((f) => f.id === 'faq-max-300');
    expect(max?.aliases.some((a) => /max 300/i.test(a))).toBe(true);
  });
});
