import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { loadConfig, saveConfig, resetConfig, getConfigKey, setConfigKey, DEFAULT_CONFIG } from "../src/config.ts";

const TMP_DIR = path.join(os.tmpdir(), `octm-test-config-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  process.env.XDG_CONFIG_HOME = TMP_DIR;
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

describe("config", () => {
  it("returns defaults when no file exists", () => {
    const cfg = loadConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.deployment_mode).toBe("auto");
    expect(cfg.content_cache.enabled).toBe(true);
  });

  it("round-trips set/get", () => {
    const cfg = loadConfig();
    const updated = setConfigKey(cfg, "content_cache.enabled", "false");
    saveConfig(updated);
    const loaded = loadConfig();
    expect(loaded.content_cache.enabled).toBe(false);
  });

  it("getConfigKey with dot notation", () => {
    const cfg = loadConfig();
    expect(getConfigKey(cfg, "content_cache.enabled")).toBe(true);
    expect(getConfigKey(cfg, "deployment_mode")).toBe("auto");
    expect(getConfigKey(cfg, "nonexistent")).toBeUndefined();
  });

  it("setConfigKey rejects unknown keys", () => {
    const cfg = loadConfig();
    expect(() => setConfigKey(cfg, "unknown.key", "value")).toThrow();
  });

  it("reset removes the config file", () => {
    const cfg = loadConfig();
    saveConfig(cfg);
    resetConfig();
    // After reset, should return defaults again
    const reloaded = loadConfig();
    expect(reloaded.deployment_mode).toBe("auto");
  });
});
