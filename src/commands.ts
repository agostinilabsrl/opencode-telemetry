import fs from "fs";
import path from "path";

/**
 * Register the telemetry command templates in the project's `.opencode/commands/`
 * directory.
 *
 * Previously this derived `scriptsDir` from the plugin source directory, embedded
 * absolute host-specific paths into command bodies via JSON.stringify, and
 * unconditionally overwrote the two command files on EVERY plugin load. That
 * polluted the project's command templates with machine-specific paths and
 * clobbered any user edits.
 *
 * The package already ships portable templates under `command/` (the same
 * `command/telemetry-report.md` + `command/telemetry-inspect.md` files that are
 * published in the npm tarball). This version:
 *  1. Copies those shipped portable templates instead of generating bodies with
 *     absolute script paths.
 *  2. Respects existing files: if the target command file already exists it is
 *     left untouched (idempotent — the project keeps its committed/edited
 *     templates).
 *  3. Only writes files that are missing, and only when the shipped template is
 *     available.
 *
 * @param packageRoot - absolute path to the installed package root (one level
 *   above `src/`), where the `command/` templates live.
 * @param projectDir - absolute path of the project directory that owns
 *   `.opencode/commands/`.
 */
export function registerCommands(packageRoot: string, projectDir: string): void {
  try {
    const commandsDir = path.join(projectDir, ".opencode", "commands");
    const shippedDir = path.join(packageRoot, "command");
    const targets = ["telemetry-report.md", "telemetry-inspect.md"];

    for (const name of targets) {
      const targetPath = path.join(commandsDir, name);
      const shippedPath = path.join(shippedDir, name);

      // Respect existing command files — never overwrite user/committed content.
      if (fs.existsSync(targetPath)) continue;

      // If the shipped template is missing (e.g. a trimmed install), skip the
      // target instead of failing the whole registration.
      if (!fs.existsSync(shippedPath)) {
        console.warn(`[opencode-telemetry] shipped template not found, skipping: ${shippedPath}`);
        continue;
      }

      fs.mkdirSync(commandsDir, { recursive: true });
      fs.copyFileSync(shippedPath, targetPath);
    }
  } catch (err) {
    console.warn("[opencode-telemetry] registerCommands failed:", err);
  }
}
