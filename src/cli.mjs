// Entry point: `node review-policy.mjs` in a workflow step.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './main.mjs';

export async function cli() {
  try {
    await run();
  } catch (err) {
    console.error(`::error::review-policy: ${err.message}`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) await cli();
