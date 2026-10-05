export function exited(): boolean {
  return !!(process.exitCode && process.exitCode !== 0);
}

export function failUsage(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}
