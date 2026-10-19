// Retrying reads for assertions. The page changes while a spec runs, so one read decides nothing:
// an assertion keeps reading until it passes or the budget is spent, then reports the last read.
import { firstLine, sleep } from "./util.js";

export const DEFAULT_TIMEOUT_MS = 3000;
const BACKOFF_MS = [25, 50, 100, 250, 500];

// evaluate() returns { pass, actual }. A throw (element missing, wrong element type) counts as a failed read.
// timeoutMs 0 means one read.
export async function poll(evaluate, timeoutMs) {
  // The monotonic clock: a wall-clock change (NTP step, manual change) must not cut a wait short or stretch it.
  const deadline = performance.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    let result;
    try {
      result = await evaluate();
    } catch (error) {
      result = { pass: false, actual: null, error: firstLine(error) };
    }
    const left = deadline - performance.now();
    if (result.pass || left <= 0) return result;
    await sleep(Math.min(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], left));
  }
}
