import { describe, expect, it } from 'vitest';
import { jobsToFlowSteps, parseJobsYamlLite } from './jobsToFlow.js';

describe('jobsToFlowSteps', () => {
  it('chains requires linearly', () => {
    const steps = jobsToFlowSteps({
      jobs: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
        { id: 'c', title: 'C', requires: ['a'] },
      ],
    });
    expect(steps.map((s) => s.requires)).toEqual([[], ['a'], ['a']]);
  });

  it('parses lite yaml', () => {
    const doc = parseJobsYamlLite(`
- id: create_list
  title: Create list
- id: add_item
  title: Add item
`);
    expect(doc.jobs).toHaveLength(2);
    expect(jobsToFlowSteps(doc)[1]?.requires).toEqual(['create_list']);
  });
});
