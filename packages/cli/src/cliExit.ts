export function exited(): boolean {
  return !!(process.exitCode && process.exitCode !== 0);
}
