/**
 * `notlm-training ranker train [dir] [--epochs=40] [--dim=128]`
 * Trains a tiny intent+slot ranker from pack corpus (+ aliases) → pack/ranker.json (+ .onnx).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  loadPackFolderJson,
  packDir,
  pathExists,
  resolveNotlmHome,
  writeJsonFile,
} from './notlmHome.js';

function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

export async function cmdRankerTrain(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith('-'));
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const files = loadPackFolderJson(home);
  const corpus = (files.corpus as ScenarioCase[] | undefined) ?? [];
  const scenarios = (files.scenarios as ScenarioCase[] | undefined) ?? [];
  const aliases =
    files.intents && typeof files.intents === 'object'
      ? ((files.intents as { aliases?: Record<string, string[]> }).aliases ?? {})
      : {};

  const labeled = [...corpus, ...scenarios].filter(
    (c) => c && typeof c.utterance === 'string' && c.expect
  );
  if (labeled.length === 0) {
    console.error('Need pack/corpus.json and/or scenarios.json with labeled cases');
    process.exitCode = 1;
    return;
  }

  const epochs = Math.max(1, Number(parseFlag(args, '--epochs') ?? '40') || 40);
  const dim = Math.max(32, Number(parseFlag(args, '--dim') ?? '128') || 128);
  const examples = examplesFromCorpus(labeled, aliases);
  const model: RankerModelJson = trainRanker(examples, { epochs, dim, seed: 42 });

  const pack = packDir(home);
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
