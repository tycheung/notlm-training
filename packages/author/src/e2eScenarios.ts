/**
 * Build end-to-end scenario stubs from flow `requires` chains.
 * Each step with requires gets a multi-step expect listing the unlock path.
 */
import type { FlowStepDef } from '@uipilot/core';

export type E2eScenario = {
  id: string;
  utterance: string;
  expect: {
    stepId: string;
    /** Prerequisite path that should already be complete for this step. */
    requiresChain?: string[];
  };
};

export function e2eScenariosFromFlow(steps: FlowStepDef[]): E2eScenario[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out: E2eScenario[] = [];
  for (const step of steps) {
    const chain: string[] = [];
    const walk = (id: string, seen: Set<string>) => {
      if (seen.has(id)) return;
      seen.add(id);
      const s = byId.get(id);
      if (!s) return;
      for (const req of s.requires ?? []) walk(req, seen);
      if (id !== step.id) chain.push(id);
    };
    walk(step.id, new Set());
    const title = step.title || step.id.replace(/_/g, ' ');
    out.push({
      id: `e2e-${step.id}`,
      utterance: `open ${title}`.toLowerCase(),
      expect: {
        stepId: step.id,
        requiresChain: chain.length ? chain : undefined,
      },
    });
  }
  return out;
}
