export { buildConversationAnalyzePrompt, buildIntentTunePrompt, buildPackAuthorPrompt } from './prompts.js';
export {
  extractJsonText,
  parseModelJson,
} from './parseModelJson.js';
export type {
  ParseModelJsonFail,
  ParseModelJsonOk,
  ParseModelJsonResult,
} from './parseModelJson.js';

export { authorPackDraft } from './packAuthor.js';
export type { AuthorPackDraftResult, PackDraftPieces } from './packAuthor.js';

export { tuneIntents } from './intentsTune.js';
export type { TuneIntentsResult } from './intentsTune.js';

export {
  analyzeConversations,
  fixtureConversationProposal,
} from './conversationAnalyze.js';
export type {
  AnalyzeConversationsResult,
  ConversationAnalyzeProposal,
} from './conversationAnalyze.js';

export {
  DEFAULT_PLATEAU_CONFIG,
  type BatchNoveltySummary,
  type NoveltyReport,
  type ParseSignatureBucket,
  type PlateauConfig,
  type ScenarioCandidate,
  type StopReason,
} from './saturation/types.js';
export {
  jaccard,
  lexicalNovelty,
  normalizeForNovelty,
} from './saturation/lexicalNovelty.js';
export {
  countSignatures,
  parseSignature,
  parseSignatureFromResult,
  parseSignatureNovelty,
} from './saturation/parseSignatureNovelty.js';
export {
  buildNoveltyReport,
  combineNovelty,
  detectPlateau,
  estimateIncrementalNovelty,
  scoreBatchAgainstPrior,
  updatePlateauState,
  type PlateauState,
  type ScoredCandidate,
} from './saturation/novelty.js';
export {
  buildScenarioGeneratePrompt,
  buildSoftLabelPrompt,
  type ScenarioGenerateMode,
  type ContextGenerateHint,
} from './saturation/generatePrompt.js';
export {
  generateScenarioCandidates,
  type GenerateCandidatesResult,
} from './saturation/generateCandidates.js';
export {
  labelCandidates,
  softLabelCandidates,
  faqDraftFromSoftLabels,
  type SoftLabelResult,
  type SoftLabeledScenario,
  type LabelContext,
  type LabelProvider,
} from './saturation/softLabel.js';
export {
  createMockLayaLabeler,
  createLayaProcessLabeler,
  createLabelerFromEnv,
  resolveLabelerKind,
  type LabelCandidate,
} from './labeler/layaLabeler.js';
export {
  mineIntentFailures,
  type FailureMineResult,
} from './saturation/failureMining.js';
export {
  llmBatchGenerator,
  splitContextBatchGenerator,
  runHardAugment,
  runSaturationLoop,
  type BatchGenerator,
  type SaturateLoopResult,
} from './saturation/saturateLoop.js';
export {
  buildContextTreePlan,
  packSliceForMode,
  pickContextMode,
  type ContextTreeMode,
  type ContextTreePlan,
} from './saturation/contextTree.js';
export { detectClashes, clashDensity, type ClashGroup } from './detectClashes.js';

export { draftConversationalCopy } from './draftTalk.js';
export type { DraftTalkResult } from './draftTalk.js';

export { e2eScenariosFromFlow, type E2eScenario } from './e2eScenarios.js';
export { glossaryStubsFromControls, type GlossaryStub } from './glossaryCrawl.js';

export {
  CAPABILITY_LANES,
  LANE_EXPECT,
  laneGeneratePrePrompt,
  lanePatchPrePrompt,
  loadStressPack,
  scoreCase,
  scoreSuite,
  loadPackJsonFromFolder,
  resolvePackFolder,
  catalogDigest,
  morphCasesForLane,
  morphFullSuite,
  generateLaneCases,
  generateFullSuite,
  fixturePatchFromFails,
  proposePackPatch,
  applyPackPatch,
  writePackFolder,
  writeAutoReport,
  DEFAULT_AUTO,
  resolveAutoConfig,
  runAutoLoop,
  type CapabilityLane,
  type LaneExpect,
  type StressCase,
  type ScoreResult,
  type SuiteSummary,
  type PackPatch,
  type AutoLoopConfig,
  type AutoLoopReport,
} from './capabilityStress/index.js';

export {
  DEFAULT_E2E_SOURCES,
  loadE2eCases,
  morphUtterance,
  evaluateUtterance,
  loadE2ePack,
  EMPTY_GRADES,
  confusionFromGraded,
  gradeOutcome,
  scoreF1FromGraded,
  applyLesson,
  applyLessonAsync,
  lessonPatchFromGraded,
  lessonPatchLlmPrompt,
  proposeLessonPatch,
  upsertScenarioRow,
  appendGradeLog,
  bumpGradeCount,
  checkpointPack,
  e2eReportDir,
  loadE2eState,
  saveE2eState,
  DEFAULT_E2E_AUTO,
  readE2eConfigFromHome,
  resolveE2eAutoConfig,
  runE2eAutoLoop,
  type E2eAutoConfig,
  type E2eAutoReport,
  type E2eAutoState,
  type E2eCase,
  type E2eExpect,
  type E2eGrade,
  type E2eGraded,
  type E2eOutcome,
} from './e2eauto/index.js';
