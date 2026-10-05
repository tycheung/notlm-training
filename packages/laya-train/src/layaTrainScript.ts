import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolved path to `scripts/laya_train.py` beside this package (dist/ or src/). */
export function layaTrainScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'scripts', 'laya_train.py');
}
