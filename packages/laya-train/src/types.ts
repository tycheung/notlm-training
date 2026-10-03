export type LayaConvertMode = 'full' | 'light';

export type ScenarioExpect = {
  stepId?: string | null;
  rawIntent?: string | null;
  goBack?: boolean;
  isCorrection?: boolean;
  faqId?: string | null;
  queryId?: string | null;
  mutationId?: string | null;
  tourId?: string | null;
  searchId?: string | null;
  answer?: string;
};

export type LabeledUtterance = {
  utterance: string;
  expect: ScenarioExpect;
  source: 'scenarios' | 'corpus';
};

export type LayaChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

export type LayaNoulQuestion = {
  type: 'noul';
  instructions: string;
};

export type LayaTypedDecisionRecord = {
  state: string;
  questions: {
    step: LayaChoiceQuestion;
    is_ood: LayaNoulQuestion;
    faq: LayaChoiceQuestion;
  };
  answers: {
    step: { choice: string };
    is_ood: { noul: number };
    faq: { choice: string };
  };
};

export type LayaConvertManifest = {
  mode: LayaConvertMode;
  rows: number;
  sources: {
    scenarios: number;
    corpus: number;
    merged: number;
  };
  stepChoicesFull: number;
  faqChoicesFull: number;
  writtenAt: string;
  trainPath: string;
  manifestPath: string;
};

export type ConvertNotlmResult = {
  manifest: LayaConvertManifest;
  records: LayaTypedDecisionRecord[];
};
