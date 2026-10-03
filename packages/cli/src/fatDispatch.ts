/** Authoring / training CLI dispatch (notlm-training). */
import {
  cmdAnnotateChecklist,
  cmdChecklistMd,
  cmdDagGenerate,
  cmdExtractStatic,
  cmdExtractHost,
  cmdIntentsTune,
  cmdInventoryAttach,
  cmdInventoryCrawl,
  cmdJobsImport,
  cmdPackAccept,
  cmdPackAuthor,
  cmdTraceIngest,
  cmdTraceNew,
} from './commands.js';
import { cmdMap, cmdPrepare, cmdTune } from './cmdMapTunePrepare.js';
import {
  cmdScenariosGenerate,
  cmdScenariosSaturate,
} from './cmdScenarios.js';
import {
  cmdScenariosAsk,
  cmdScenariosLabelPool,
} from './cmdScenariosAsk.js';
import { cmdRankerTrain } from './cmdRanker.js';
import { cmdLaya } from './cmdLaya.js';
import { cmdTalkDraft } from './cmdTalkDraft.js';
import {
  cmdMissesDraftAliases,
  cmdMissesExport,
  cmdMissesPull,
} from './cmdMisses.js';
import {
  cmdTrainAuto,
  cmdTrainPause,
  cmdTrainResume,
  cmdTrainStop,
} from './cmdTrainAuto.js';

const FAT_TOP = new Set([
  'inventory',
  'extract',
  'trace',
  'annotate',
  'jobs',
  'checklist',
  'dag',
  'pack',
  'scenarios',
  'map',
  'tune',
  'prepare',
  'talk',
  'misses',
  'train',
  'laya',
]);

export function isFatCommand(cmd: string | undefined, sub?: string): boolean {
  if (!cmd) return false;
  if (FAT_TOP.has(cmd)) {
    if (cmd === 'pack') return sub === 'author' || sub === 'accept';
    if (cmd === 'train') {
      return (
        sub === 'auto' || sub === 'pause' || sub === 'resume' || sub === 'stop'
      );
    }
    return true;
  }
  if (cmd === 'intents' && sub === 'tune') return true;
  if (cmd === 'ranker' && sub === 'train') return true;
  if (cmd === 'laya') return sub === 'convert' || sub === 'train';
  return false;
}

export async function runFatCli(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;

  switch (cmd) {
    case 'inventory':
      if (sub === 'crawl') await cmdInventoryCrawl(rest);
      else if (sub === 'attach') await cmdInventoryAttach(rest);
      else throw new Error('Usage: inventory crawl|attach …');
      break;
    case 'extract':
      if (sub === 'host') {
        await cmdExtractHost(rest);
        break;
      }
      if (sub !== 'static') throw new Error('Usage: extract static … | extract host <hostAppRoot>');
      await cmdExtractStatic(rest);
      break;
      break;
    case 'trace':
      if (sub === 'ingest') await cmdTraceIngest(rest);
      else if (sub === 'new') await cmdTraceNew(rest);
      else throw new Error('Usage: trace ingest|new …');
      break;
    case 'annotate':
      if (sub !== 'checklist') throw new Error('Usage: annotate checklist …');
      await cmdAnnotateChecklist(rest);
      break;
    case 'jobs':
      if (sub !== 'import') throw new Error('Usage: jobs import …');
      await cmdJobsImport(rest);
      break;
    case 'checklist':
      if (sub !== 'md') throw new Error('Usage: checklist md …');
      await cmdChecklistMd(rest);
      break;
    case 'dag':
      if (sub !== 'generate') throw new Error('Usage: dag generate …');
      await cmdDagGenerate(rest[0]);
      break;
    case 'pack':
      if (sub === 'author') await cmdPackAuthor(rest[0]);
      else if (sub === 'accept') await cmdPackAccept(rest[0]!, rest[1]);
      else throw new Error('Usage: pack author|accept …');
      break;
    case 'intents':
      if (sub === 'tune') await cmdIntentsTune(rest[0]);
      else throw new Error('Usage: intents tune … (intents check stays on notlmCLI)');
      break;
    case 'scenarios':
      if (sub === 'generate') await cmdScenariosGenerate(rest);
      else if (sub === 'saturate') await cmdScenariosSaturate(rest);
      else if (sub === 'label-pool') await cmdScenariosLabelPool(rest);
      else if (sub === 'ask') await cmdScenariosAsk(rest);
      else throw new Error('Usage: scenarios generate|saturate|ask|label-pool …');
      break;
    case 'map':
      await cmdMap([sub, ...rest].filter((x) => x !== undefined) as string[]);
      break;
    case 'tune':
      await cmdTune([sub, ...rest].filter((x) => x !== undefined) as string[]);
      break;
    case 'prepare':
      await cmdPrepare([sub, ...rest].filter((x) => x !== undefined) as string[]);
      break;
    case 'talk':
      if (sub === 'draft') await cmdTalkDraft(rest);
      else throw new Error('Usage: talk draft …');
      break;
    case 'ranker':
      if (sub === 'train') await cmdRankerTrain(rest);
      else throw new Error('Usage: ranker train … (ranker check stays on notlmCLI)');
      break;
    case 'laya':
      await cmdLaya([sub, ...rest].filter(Boolean) as string[]);
      break;
    case 'misses':
      if (sub === 'export') await cmdMissesExport(rest);
      else if (sub === 'pull') await cmdMissesPull(rest);
      else if (sub === 'draft-aliases') await cmdMissesDraftAliases(rest);
      else throw new Error('Usage: misses export|pull|draft-aliases …');
      break;
    case 'train':
      if (sub === 'auto') await cmdTrainAuto(rest);
      else if (sub === 'pause') await cmdTrainPause(rest);
      else if (sub === 'resume') await cmdTrainResume(rest);
      else if (sub === 'stop') await cmdTrainStop(rest);
      else throw new Error('Usage: train auto|pause|resume|stop …');
      break;
    default:
      throw new Error(`Not a fat command: ${cmd}`);
  }
}
