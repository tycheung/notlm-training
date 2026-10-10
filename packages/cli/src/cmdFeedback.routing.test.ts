import { describe, expect, it, vi } from 'vitest';

vi.mock('./cmdFeedbackPromote.js', () => ({
  cmdFeedbackPromote: vi.fn(async () => undefined),
}));

vi.mock('./cli.js', () => ({
  cmdPull: vi.fn(),
  cmdDraft: vi.fn(),
  cmdFold: vi.fn(),
  cmdMetrics: vi.fn(),
  takeFlag: (args: string[], name: string) => {
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  },
}));

vi.mock('./cmdMisses.js', () => ({
  cmdMissesCluster: vi.fn(),
  cmdMissesDraftAliases: vi.fn(),
  cmdMissesExport: vi.fn(),
  cmdMissesPull: vi.fn(),
  cmdPackEmbedIndex: vi.fn(),
}));

vi.mock('./cmdConversations.js', () => ({
  cmdConversationsAnalyze: vi.fn(),
  cmdConversationsPull: vi.fn(),
}));

vi.mock('./commands.js', () => ({
  cmdPackAccept: vi.fn(),
}));

vi.mock('./cmdScenarios.js', () => ({
  cmdScenariosSaturate: vi.fn(),
}));

vi.mock('./pipelinePost.js', () => ({
  runPipelinePost: vi.fn(async () => ({
    ok: true,
    embed: { ran: false, reason: 'x' },
    ranker: { ran: false, reason: 'x' },
    laya: { ran: false, reason: 'x' },
  })),
  wantsLaya: () => false,
}));

import { cmdFeedbackPromote } from './cmdFeedbackPromote.js';
import { cmdFeedback } from './cmdFeedback.js';

describe('feedback routing', () => {
  it('rejects unknown subcommands instead of promoting', async () => {
    process.exitCode = 0;
    await cmdFeedback(['pul', '../react-frontend']);
    expect(process.exitCode).toBe(1);
    expect(cmdFeedbackPromote).not.toHaveBeenCalled();
  });

  it('routes promote and bare flags to promote pipeline', async () => {
    process.exitCode = 0;
    await cmdFeedback(['promote', '--from', 'x.json']);
    expect(cmdFeedbackPromote).toHaveBeenCalled();
  });
});
