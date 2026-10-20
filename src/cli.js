// The one place a command's top level ends: run main, set the exit code, and turn an unexpected error into an exit 2 with a
// scrubbed message. Every command's entry block calls this, so a new command cannot print a raw error (the text of a system
// error names the path it failed on). Exit 2, never 1: 1 means "a check failed", and an unexpected exception is not that.
import { safeLine } from "./receipt-scrub.js";

export async function runCli(main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`ERROR: ${safeLine(error)}`);
    process.exitCode = 2;
  }
}
