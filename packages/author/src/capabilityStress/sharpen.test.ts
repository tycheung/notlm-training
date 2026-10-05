import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { PackJsonInput } from '@notlm/core';
import type { LlmProvider } from '@notlm-training/llm';
import {
  CAPABILITY_LANES,
  applyPackPatch,
  catalogDigest,
  fixturePatchFromFails,
  generateFullSuite,
  laneGeneratePrePrompt,
  lanePatchPrePrompt,
  loadPackJsonFromFolder,
  loadStressPack,
  morphCasesForLane,
  morphFullSuite,
  proposePackPatch,
  resolvePackFolder,
  resolveAutoConfig,
  runAutoLoop,
  scoreCase,
  scoreSuite,
  writePackFolder,
  type StressCase,
} from './index.js';

function mockProvider(text: string): LlmProvider {
  return {
    async completeChat() {
      return text;
    },
  };
}

function miniPack(): PackJsonInput {
  return {
    manifest: { id: 'test-pack', productRole: 'test product assistant' },
    flow: [
      {
        id: 'open_home',
        title: 'Home',
        keywords: ['home'],
        kind: 'hard',
        requires: [],
      },
      {
        id: 'create_tournament',
        title: 'Create tournament',
        keywords: ['create', 'tournament'],
        kind: 'hard',
        requires: [],
      },
    ],
    controls: [
      { id: 'c_home', stepId: 'open_home', path: '/home' },
      { id: 'c_create', stepId: 'create_tournament', path: '/create' },
    ],
    intents: {
      aliases: {
        open_home: ['open home', 'go home', 'take me home'],
        create_tournament: [
          'create tournament',
          'open create tournament',
          'start a tournament',
        ],
      },
      meta: ['open_', 'create_'],
    },
    binders: {},
    faq: [
      {
        id: 'faq_avg',
        aliases: ['what is average', 'explain averages', 'how do averages work'],
        text: 'Averages are used for handicaps.',
      },
      {
        id: 'faq_sa',
        aliases: [
          'sa vs tournament',
          'difference between sa and tournament',
          'singles versus teams',
        ],
        text: 'SA is singles; tournaments can be teams.',
      },
    ],
    queries: [
      {
        id: 'q_desk',
        title: 'Desk handoff',
        aliases: ['desk handoff', 'standup summary', 'front desk briefing'],
      },
      {
        id: 'q_billing',
        title: 'Billing',
        aliases: ['billing status', 'subscription status', 'pending invoices'],
      },
    ],
    mutations: [
      {
        id: 'm_create',
        title: 'Create',
        aliases: ['create event now', 'prefill tournament'],
        risk: 'low',
      },
      {
        id: 'm_usbc',
        title: 'Assign USBC',
        aliases: ['assign usbc id', 'set external usbc'],
        risk: 'high',
      },
    ],
    tours: [
      {
        id: 't_onboard',
        title: 'Onboarding',
        aliases: ['show me around', 'start onboarding tour', 'walkthrough scoring'],
        steps: ['open_home'],
      },
    ],
    search: [
      {
        id: 's_centers',
        title: 'Centers',
        aliases: ['find centers', 'search centers', 'lookup bowling centers'],
        path: '/centers',
      },
    ],
    normalize: {
      contextAskPhrases: ['why is save greyed out', 'what am I missing'],
      explainLastPhrases: ['what did you just do', 'explain that last action'],
    },
    heuristics: {
      deskHandoffPatterns: ['\\bdesk handoff\\b', '\\bstandup\\b'],
    },
  };
}

function writeMiniPackDir(packDir: string, pack: PackJsonInput): void {
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(pack.manifest));
  writeFileSync(join(packDir, 'flow.json'), JSON.stringify(pack.flow));
  writeFileSync(join(packDir, 'controls.json'), JSON.stringify(pack.controls));
  writeFileSync(join(packDir, 'intents.json'), JSON.stringify(pack.intents));
  writeFileSync(
    join(packDir, 'binders.json'),
    JSON.stringify([
      { stepId: 'open_home', predicate: { path: 'x', equals: true } },
    ])
  );
  writeFileSync(join(packDir, 'faq.json'), JSON.stringify(pack.faq));
  writeFileSync(join(packDir, 'queries.json'), JSON.stringify({ queries: pack.queries }));
  writeFileSync(
    join(packDir, 'mutations.json'),
    JSON.stringify({ mutations: pack.mutations })
  );
  writeFileSync(join(packDir, 'tours.json'), JSON.stringify({ tours: pack.tours }));
  writeFileSync(join(packDir, 'search.json'), JSON.stringify({ search: pack.search }));
  writeFileSync(join(packDir, 'normalize.json'), JSON.stringify(pack.normalize));
  writeFileSync(join(packDir, 'heuristics.json'), JSON.stringify(pack.heuristics));
  writeFileSync(join(packDir, 'lookups.json'), JSON.stringify({ lookups: [] }));
  writeFileSync(join(packDir, 'replies.json'), JSON.stringify({}));
  mkdirSync(join(packDir, 'subgraphs'), { recursive: true });
  writeFileSync(
    join(packDir, 'subgraphs', 'nested.json'),
    JSON.stringify([
      {
        id: 'nested_step',
        title: 'Nested',
        keywords: ['nested'],
        kind: 'soft',
        requires: [],
      },
    ])
  );
}

describe('capabilityStress sharpen', () => {
  it('exposes 13 lanes and preset pre-prompts', () => {
    expect(CAPABILITY_LANES).toHaveLength(13);
    const prompt = laneGeneratePrePrompt({
      lane: 'goto',
      productRole: 'test',
      catalogDigest: 'steps: open_home',
      count: 10,
      avoidSamples: ['open home'],
    });
    expect(prompt).toContain('Lane: goto');
    expect(prompt).toContain('Generate exactly 10');
    expect(prompt).toContain('Avoid');
    const patchPrompt = lanePatchPrePrompt({
      productRole: 'test',
      failures: [{ lane: 'goto', text: 'x', hit: 'miss', reply: 'y' }],
      catalogDigest: 'steps: a',
    });
    expect(patchPrompt).toContain('aliases');
  });

  it('loads pack folder + catalog digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-packload-'));
    const packDir = join(root, 'pack');
    writeMiniPackDir(packDir, miniPack());
    expect(resolvePackFolder(root)).toBe(packDir);
    expect(resolvePackFolder(packDir)).toBe(packDir);
    const loaded = loadPackJsonFromFolder(packDir);
    expect(loaded.manifest.id).toBe('test-pack');
    expect(loaded.queries?.length).toBe(2);
    expect(loaded.subgraphs?.nested).toBeTruthy();
    expect(catalogDigest(loaded)).toContain('open_home');
    rmSync(root, { recursive: true, force: true });
  });

  it('scores seeded cases across major lanes', () => {
    const pack = loadStressPack(miniPack());
    const checks: Array<[StressCase, boolean]> = [
      [
        {
          id: 'g1',
          type: 'goto',
          text: 'open create tournament',
          expect: 'Opening|open',
        },
        true,
      ],
      [
        {
          id: 'f1',
          type: 'faq',
          text: 'what is average',
          expect: 'FAQ|average',
        },
        true,
      ],
      [
        {
          id: 'o1',
          type: 'ood',
          text: 'tell me a joke',
          expect: 'refuse|do not have the ability|off-domain|outside|not able',
        },
        true,
      ],
      [
        {
          id: 'q1',
          type: 'query',
          text: 'billing status',
          expect: 'Query',
        },
        true,
      ],
      [
        {
          id: 'm1',
          type: 'mutation',
          text: 'create event now',
          expect: 'Mutation',
        },
        true,
      ],
      [
        {
          id: 't1',
          type: 'tour',
          text: 'show me around',
          expect: 'Tour',
        },
        true,
      ],
      [
        {
          id: 's1',
          type: 'search',
          text: 'find centers',
          expect: 'Search',
        },
        true,
      ],
      [
        {
          id: 'c1',
          type: 'context',
          text: 'why is save greyed out',
          expect: "You're on|checklist|missing|grey|gray|disabled",
        },
        true,
      ],
      [
        {
          id: 'a1',
          type: 'audit',
          text: 'what did you just do',
          expect: 'Last action',
        },
        true,
      ],
      [
        {
          id: 'd1',
          type: 'disambiguation',
          text: 'I meant the other one',
          expect: 'Which one|Pick a numbered|Canceled|Taking you',
        },
        true,
      ],
      [
        {
          id: 'h1',
          type: 'handoff',
          text: 'desk handoff summary',
          expect: 'Query|desk|handoff',
        },
        true,
      ],
      [
        {
          id: 'cmp1',
          type: 'compare',
          text: 'sa vs tournament',
          expect: 'FAQ|SA|versus|vs|difference',
        },
        true,
      ],
    ];
    for (const [c, wantOk] of checks) {
      const r = scoreCase(c, pack);
      expect(r.ok, `${c.type}:${c.text} hit=${r.hit} reply=${r.reply}`).toBe(wantOk);
    }
  });

  it('morph generates per-lane suite including empty-seed fallbacks', async () => {
    const pack = miniPack();
    const cases = morphFullSuite(pack, 3);
    expect(cases.length).toBe(CAPABILITY_LANES.length * 3);
    for (const lane of CAPABILITY_LANES) {
      expect(morphCasesForLane(lane, pack, 1).length).toBe(1);
    }
    const empty: PackJsonInput = {
      manifest: { id: 'e' },
      flow: [],
      controls: [],
      intents: { aliases: {} },
      binders: {},
    };
    expect(morphCasesForLane('goto', empty, 2).length).toBe(2);
    const gen = await generateFullSuite({
      pack,
      perLane: 2,
      fixture: true,
      lanes: ['faq', 'goto'],
    });
    expect(gen).toHaveLength(4);
  });

  it('proposePackPatch uses LLM JSON when provided', async () => {
    const pack = miniPack();
    const summary = scoreSuite(
      [
        {
          id: 'f',
          type: 'goto',
          text: 'totally unknown nav phrase',
          expect: 'Opening',
        },
      ],
      loadStressPack(pack)
    );
    const patch = await proposePackPatch({
      pack,
      summary: {
        ...summary,
        failures: [
          {
            id: 'f',
            lane: 'goto',
            text: 'totally unknown nav phrase',
            hit: 'miss',
            reply: 'x',
            issues: ['expect_miss'],
          },
        ],
        hardFails: 1,
      },
      provider: mockProvider(
        JSON.stringify({
          aliases: { create_tournament: ['totally unknown nav phrase'] },
          notes: 'ok',
        })
      ),
    });
    expect(patch.aliases?.create_tournament).toContain('totally unknown nav phrase');
    applyPackPatch(pack, {
      faq: [{ id: 'faq_avg', aliases: ['new faq phrase'], text: 't' }],
      queryAliases: { q_desk: ['new desk phrase'] },
      mutationAliases: { m_create: ['new mut'] },
      tourAliases: { t_onboard: ['new tour'] },
      searchAliases: { s_centers: ['new search'] },
      contextAskPhrases: ['why grey now'],
      explainLastPhrases: ['explain prior'],
    });
    expect(pack.faq?.[0]?.aliases).toContain('new faq phrase');
    expect(pack.queries?.[0]?.aliases).toContain('new desk phrase');
    expect(pack.normalize?.contextAskPhrases).toContain('why grey now');
  });

  it('fixture sharpen loop patches pack and writes report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-sharpen-'));
    const packDir = join(root, 'pack');
    const reportDir = join(root, 'report');
    const pack = miniPack();
    writeMiniPackDir(packDir, pack);

    const cfg = resolveAutoConfig({
      perLane: 4,
      passRate: 0.5,
      maxRounds: 5,
      fixture: true,
      writePack: true,
      lanes: ['goto', 'faq', 'ood'],
    });

    const report = await runAutoLoop({
      pack,
      packDir,
      reportDir,
      config: cfg,
    });

    expect(report.final.total).toBeGreaterThan(0);
    expect(report.history.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(reportDir, 'report.json'))).toBe(true);

    // Force a failing suite so repair rounds execute.
    const hardCases: StressCase[] = [
      {
        id: 'bad1',
        type: 'goto',
        text: 'brand new nav phrase xyz',
        expect: 'Opening',
      },
      {
        id: 'bad2',
        type: 'faq',
        text: 'brand new faq phrase xyz',
        expect: 'FAQ',
      },
      {
        id: 'ok1',
        type: 'goto',
        text: 'open create tournament',
        expect: 'Opening',
      },
    ];
    const repair = await runAutoLoop({
      pack: miniPack(),
      packDir,
      reportDir: join(root, 'report2'),
      cases: hardCases,
      config: {
        perLane: 1,
        passRate: 0.99,
        maxRounds: 3,
        fixture: true,
        writePack: true,
      },
    });
    expect(repair.rounds).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(packDir, 'intents.json'))).toBe(true);

    const summary = scoreSuite(
      [
        {
          id: 'x',
          type: 'goto',
          text: 'open create tournament',
          expect: 'Opening',
        },
      ],
      loadStressPack(pack)
    );
    const patch = fixturePatchFromFails(pack, {
      ...summary,
      failures: [
        {
          id: 'fail1',
          lane: 'goto',
          text: 'brand new nav phrase xyz',
          hit: 'miss',
          reply: 'x',
          issues: ['expect_miss'],
        },
        {
          id: 'fail2',
          lane: 'context',
          text: 'why blocked',
          hit: 'miss',
          reply: 'x',
          issues: ['expect_miss'],
        },
        {
          id: 'fail3',
          lane: 'audit',
          text: 'explain prior move',
          hit: 'miss',
          reply: 'x',
          issues: ['expect_miss'],
        },
        {
          id: 'fail4',
          lane: 'mutation_high_risk',
          text: 'assign weird usbc',
          hit: 'miss',
          reply: 'x',
          issues: ['expect_miss'],
        },
        {
          id: 'fail5',
          lane: 'tour',
          text: 'tour please now',
          hit: 'miss',
          reply: 'x',
          issues: ['expect_miss'],
        },
        {
          id: 'fail6',
          lane: 'search',
          text: 'search please now',
          hit: 'miss',
          reply: 'x',
          issues: ['expect_miss'],
        },
        {
          id: 'fail7',
          lane: 'handoff',
          text: 'handoff please',
          hit: 'miss',
          reply: 'x',
          issues: ['expect_miss'],
        },
        {
          id: 'fail8',
          lane: 'compare',
          text: 'compare please',
          hit: 'miss',
          reply: 'x',
          issues: ['expect_miss'],
        },
      ],
      hardFails: 8,
    });
    applyPackPatch(pack, patch);
    writePackFolder(packDir, pack);
    expect(readFileSync(join(packDir, 'normalize.json'), 'utf8')).toContain('why blocked');

    // Expect can never match → hardFails stay flat → stall / regenerate path.
    const stallCases: StressCase[] = Array.from({ length: 4 }, (_, i) => ({
      id: `stall-${i}`,
      type: 'goto' as const,
      text: `open create tournament`,
      expect: '^IMPOSSIBLE_NEVER_MATCH$',
    }));
    const stalled = await runAutoLoop({
      pack: miniPack(),
      packDir,
      reportDir: join(root, 'report3'),
      cases: stallCases,
      config: {
        perLane: 1,
        passRate: 0.999,
        maxRounds: 4,
        fixture: true,
        writePack: false,
        lanes: ['goto'],
      },
    });
    expect(stalled.ok).toBe(false);
    expect(['stalled', 'max_rounds']).toContain(stalled.stopReason);

    rmSync(root, { recursive: true, force: true });
  });
});
