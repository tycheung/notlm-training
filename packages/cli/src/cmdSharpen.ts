/**
 * Deprecated alias: `notlm-training sharpen` → `notlm-training auto`
 */
import { cmdAuto } from './cmdAuto.js';

export async function cmdSharpen(args: string[]): Promise<void> {
  console.warn('[deprecated] use `notlm-training auto` instead of `sharpen`');
  await cmdAuto(args);
}
