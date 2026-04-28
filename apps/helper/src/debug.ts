// Verbose helper logs (ownership transitions, IPC broadcasts, model-change
// bookkeeping) are only useful when actively debugging those flows. In normal
// dev they flood the terminal a few times per second and slow it to a crawl.
// Set AGENT_PULSE_DEBUG=1 to re-enable them.
const DEBUG_ENABLED = process.env.AGENT_PULSE_DEBUG === '1';

export function debugLog(...args: unknown[]): void {
  if (DEBUG_ENABLED) {
    console.log(...args);
  }
}

export const debugEnabled = DEBUG_ENABLED;
