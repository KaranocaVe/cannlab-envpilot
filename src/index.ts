#!/usr/bin/env node

import { buildProgram } from "./cli.js";
import { errorMessage, errorPayload } from "./errors.js";

const program = buildProgram();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const json = process.argv.includes("--json");
  if (json) process.stderr.write(`${JSON.stringify(errorPayload(error))}\n`);
  else process.stderr.write(`cannlabctl: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
