import { basename, join, resolve } from 'node:path';
import {
  seedCorpusFromAliases,
  seedIntentsFromSteps,
  traceToFlowDraft,
  writeTraceFile,
  type ClickTrace,
} from '@notlm-training/mapper';
import {
  draftsDir,
  ensureDir,
  pathExists,
  readJsonFile,
  resolveNotlmHome,
  writeJsonFile,
} from './notlmHome.js';

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function cmdTraceNew(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith('-'));
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trace: ClickTrace = {
    recordedAt: new Date().toISOString(),
    baseUrl: '',
    events: [],
  };
  const saved = writeTraceFile(home, trace, `trace-recording-${stamp}`);
  console.log(`Started empty trace at ${saved}`);
  console.log('Append click/navigate events, then: notlm-training trace ingest <file> [dir]');
}

export async function cmdTraceIngest(args: string[]): Promise<void> {
  const traceFile = args.find((a) => !a.startsWith('-'));
  const dir = args.filter((a) => a !== traceFile && !a.startsWith('-')).at(-1);

  if (!traceFile) {
    console.error('Usage: notlm-training trace ingest <trace.json> [dir]');
    process.exitCode = 1;
    return;
  }

  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const abs = resolve(traceFile);
  if (!pathExists(abs)) {
    console.error(`Trace file not found: ${abs}`);
    process.exitCode = 1;
    return;
  }

  const trace = readJsonFile<ClickTrace>(abs);
  const baseName = basename(abs).replace(/\.json$/i, '');
  const traceId = baseName.startsWith('trace-') ? baseName : `trace-${baseName}`;

  const saved = writeTraceFile(home, trace, traceId);

  const { steps } = traceToFlowDraft(trace);
  const intents = seedIntentsFromSteps(steps);
  const corpus = seedCorpusFromAliases(intents.aliases);

  const draftId = `trace-${stamp()}`;
  const outDir = join(draftsDir(home), draftId);
  ensureDir(outDir);
  writeJsonFile(join(outDir, 'flow.json'), steps);
  writeJsonFile(join(outDir, 'intents.json'), intents);
  writeJsonFile(join(outDir, 'corpus.json'), corpus);
  writeJsonFile(join(outDir, 'meta.json'), {
    id: draftId,
    kind: 'trace-ingest',
    sourceTrace: saved,
    createdAt: new Date().toISOString(),
    checked: false,
    confidence: 'low',
  });

  console.log(`Ingested trace -> ${saved}; draft ${outDir} (${steps.length} steps)`);
}

