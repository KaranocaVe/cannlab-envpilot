import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";

import { ConfirmationRequiredError } from "./errors.js";

export async function confirmDestructive(message: string, yes = false): Promise<void> {
  if (yes) return;
  if (!input.isTTY || !output.isTTY) throw new ConfirmationRequiredError(`${message} Use --yes in a non-interactive shell.`);
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} Type "yes" to continue: `);
    if (answer.trim().toLowerCase() !== "yes") throw new ConfirmationRequiredError("Operation cancelled.");
  } finally {
    rl.close();
  }
}
