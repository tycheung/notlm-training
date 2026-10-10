/** Trains intent+slot ranker from pack corpus (+ aliases) → pack/ranker.json (+ .onnx). */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePackFolder } from '@notlm-training/author';
import {
  examplesFromCorpus,
  exportIntentOnnx,
  formatCalibrationSummary,
  reportRankerCalibration,
  trainRanker,
} from '@notlm-training/ranker-train';
import type { RankerModelJson } from '@notlm/ranker';
import type { ScenarioCase } from '@notlm/core';
import {
  ensureDir,
  pathExists,
  resolveActivePackDir,
  resolveNotlmHome,
  unwrapCatalogArray,
  writeJsonFile,
} from './notlmHome.js';
import { parseFlag } from './cliFlags.js';

function readJsonArray(path: string, key: string): ScenarioCase[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return unwrapCatalogArray(raw, key) as ScenarioCase[];
  } catch {
    return [];
  }
}

export async function cmdRankerTrain(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith('-'));
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const pack = resolveActivePackDir(home, projectRoot, resolvePackFolder);
  const corpus = readJsonArray(join(pack, 'corpus.json'), 'corpus');
  const scenarios = readJsonArray(join(home, 'scenarios.json'), 'scenarios');
  let aliases: Record<string, string[]> = {};
  try {
    const intents = JSON.parse(readFileSync(join(pack, 'intents.json'), 'utf8')) as {
      aliases?: Record<string, string[]>;
    };
    aliases = intents.aliases ?? {};
  } catch {
    /* optional */
  }

  const labeled = [...corpus, ...scenarios].filter(
    (c) => c && typeof c.utterance === 'string' && c.expect
  );
  const epochs = Math.max(1, Number(parseFlag(args, '--epochs') ?? '40') || 40);
  const dim = Math.max(32, Number(parseFlag(args, '--dim') ?? '128') || 128);
  const examples = examplesFromCorpus(labeled, aliases);
  if (examples.length === 0) {
    console.error(
      'Need trainable ranker examples (step/faq corpus rows and/or non-empty intent aliases); query-only rows are skipped'
    );
    process.exitCode = 1;
    return;
  }
  const model: RankerModelJson = trainRanker(examples, { epochs, dim, seed: 42 });

  ensureDir(pack);
  const jsonPath = join(pack, 'ranker.json');
  writeJsonFile(jsonPath, model);

  const onnxPath = join(pack, 'ranker.onnx');
  try {
    const bytes = exportIntentOnnx(model);
    writeFileSync(onnxPath, bytes);
    console.log(`Wrote ${jsonPath} + ${onnxPath} (${model.exampleCount} examples, ${model.intentLabels.length} intents)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`ONNX export skipped: ${msg}`);
    console.log(`Wrote ${jsonPath} (${model.exampleCount} examples, ${model.intentLabels.length} intents)`);
  }
  console.log('Enable at runtime: features.onnxRanker=true or NOTLM_ONNX_RANKER=1');
  const cal = reportRankerCalibration(model, labeled, { minProbability: 0.35 });
  console.log(formatCalibrationSummary(cal));
}
