import { describe, it, expect } from "bun:test";
import { parseArgs, flagBool, flagInt, flagStr } from "../src/cli/args.ts";

describe("parseArgs", () => {
  it("parses command and subcommand", () => {
    const r = parseArgs(["report", "--days", "7"]);
    expect(r.command).toBe("report");
    expect(r.subcommand).toBeNull();
    expect(r.flags.get("days")).toBe("7");
  });

  it("parses inspect with session id as subcommand", () => {
    const r = parseArgs(["inspect", "ses_abc123", "--content"]);
    expect(r.command).toBe("inspect");
    expect(r.subcommand).toBe("ses_abc123");
    expect(r.flags.get("content")).toBe(true);
  });

  it("parses config set with two positionals", () => {
    const r = parseArgs(["config", "set", "content_cache.enabled", "false"]);
    expect(r.command).toBe("config");
    expect(r.subcommand).toBe("set");
    expect(r.positionals).toEqual(["content_cache.enabled", "false"]);
  });

  it("boolean flag without value", () => {
    const r = parseArgs(["report", "--no-save"]);
    expect(flagBool(r.flags, "no-save")).toBe(true);
    expect(flagBool(r.flags, "save")).toBe(false);
  });

  it("integer flag", () => {
    const r = parseArgs(["report", "--days", "14"]);
    expect(flagInt(r.flags, "days", 7)).toBe(14);
  });

  it("default for missing flag", () => {
    const r = parseArgs(["report"]);
    expect(flagInt(r.flags, "days", 7)).toBe(7);
    expect(flagStr(r.flags, "format", "md")).toBe("md");
  });
});
