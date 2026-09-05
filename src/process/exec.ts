import { spawn } from "node:child_process";

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export function runCommandWithTimeout(
  command: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const [file, ...args] = command;
  if (!file) throw new Error("Command is required.");

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      resolve({ code: null, stdout, stderr: stderr || "Command timed out." });
    }, options.timeoutMs ?? 30_000);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });
  });
}
