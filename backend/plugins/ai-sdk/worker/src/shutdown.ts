import type { Identity } from "./protocol.js";

export function exitCandidate(identity: Identity, outcome: "success" | "cancelled" | "failed"): void {
  process.exitCode = 0;
  process.once("beforeExit", () => {
    process.stdout.write(JSON.stringify({
      format_version: 1, ...identity, kind: "exit_candidate", role: "worker",
      process_id: process.pid, outcome,
    }) + "\n");
  });
}
