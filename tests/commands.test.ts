import { describe, it, expect, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { registerCommands } from "../src/commands.ts";

const tempDirs: string[] = [];

function makeTempDirs(): { projectDir: string; packageRoot: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "octm-cmd-project-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octm-cmd-pkg-"));
  tempDirs.push(projectDir, packageRoot);
  return { projectDir, packageRoot };
}

function writeTemplate(packageRoot: string, name: string, content: string): void {
  const commandDir = path.join(packageRoot, "command");
  fs.mkdirSync(commandDir, { recursive: true });
  fs.writeFileSync(path.join(commandDir, name), content, "utf8");
}

function targetPath(projectDir: string, name: string): string {
  return path.join(projectDir, ".opencode", "commands", name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("registerCommands", () => {
  it("does not overwrite an existing target command file", () => {
    const { projectDir, packageRoot } = makeTempDirs();
    writeTemplate(packageRoot, "telemetry-report.md", "shipped report template");
    writeTemplate(packageRoot, "telemetry-inspect.md", "shipped inspect template");

    const existing = targetPath(projectDir, "telemetry-report.md");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "user-edited content", "utf8");

    registerCommands(packageRoot, projectDir);

    // Existing file is left untouched (respect-existing guard)...
    expect(fs.readFileSync(existing, "utf8")).toBe("user-edited content");
    // ...while the missing sibling target still gets its shipped template.
    expect(fs.readFileSync(targetPath(projectDir, "telemetry-inspect.md"), "utf8")).toBe("shipped inspect template");
  });

  it("copies the shipped template when the target is missing", () => {
    const { projectDir, packageRoot } = makeTempDirs();
    writeTemplate(packageRoot, "telemetry-report.md", "shipped report template");
    writeTemplate(packageRoot, "telemetry-inspect.md", "shipped inspect template");

    registerCommands(packageRoot, projectDir);

    expect(fs.readFileSync(targetPath(projectDir, "telemetry-report.md"), "utf8")).toBe("shipped report template");
    expect(fs.readFileSync(targetPath(projectDir, "telemetry-inspect.md"), "utf8")).toBe("shipped inspect template");
  });

  it("skips with a warning when the shipped template is missing, without crashing", () => {
    const { projectDir, packageRoot } = makeTempDirs();
    // Package root ships no command/ templates.

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      registerCommands(packageRoot, projectDir);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((w) => w.includes("shipped template not found"))).toBe(true);
    // Nothing was written for either target.
    expect(fs.existsSync(targetPath(projectDir, "telemetry-report.md"))).toBe(false);
    expect(fs.existsSync(targetPath(projectDir, "telemetry-inspect.md"))).toBe(false);
  });
});
