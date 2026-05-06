// Minimal argv parser — no external dependencies.
export interface ParsedArgs {
  command: string;
  subcommand: string | null;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // argv = process.argv.slice(2) — ["report", "--days", "7", "--save"]
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let command = "";
  let subcommand: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (!command) {
      command = arg;
    } else if (!subcommand && !positionals.length) {
      subcommand = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, subcommand, positionals, flags };
}

export function flag(flags: Map<string, string | boolean>, key: string): string | boolean | undefined {
  return flags.get(key);
}

export function flagStr(flags: Map<string, string | boolean>, key: string, def?: string): string | undefined {
  const v = flags.get(key);
  return typeof v === "string" ? v : def;
}

export function flagBool(flags: Map<string, string | boolean>, key: string, def = false): boolean {
  const v = flags.get(key);
  return v === undefined ? def : v !== false;
}

export function flagInt(flags: Map<string, string | boolean>, key: string, def: number): number {
  const v = flags.get(key);
  if (typeof v === "string") { const n = parseInt(v, 10); if (!isNaN(n)) return n; }
  return def;
}
