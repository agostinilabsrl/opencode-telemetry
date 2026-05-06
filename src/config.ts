import fs from "fs";
import path from "path";
import os from "os";

export interface TelemetryConfig {
  version: number;
  content_cache: {
    enabled: boolean;
    path: string;
  };
  sdk_bridge: {
    enabled: boolean;
  };
  deployment_mode: "auto" | "single_user" | "server";
}

const DEFAULT_CACHE_PATH = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
  "opencode-telemetry",
  "content-cache"
);

export const DEFAULT_CONFIG: TelemetryConfig = {
  version: 1,
  content_cache: {
    enabled: true,
    path: DEFAULT_CACHE_PATH,
  },
  sdk_bridge: {
    enabled: true,
  },
  deployment_mode: "auto",
};

function getConfigPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "opencode-telemetry", "config.json");
}

export function loadConfig(): TelemetryConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, content_cache: { ...DEFAULT_CONFIG.content_cache } };
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<TelemetryConfig>;
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch {
    return { ...DEFAULT_CONFIG, content_cache: { ...DEFAULT_CONFIG.content_cache } };
  }
}

export function saveConfig(config: TelemetryConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// Resolve effective config: server mode forces cache off
export function effectiveConfig(config: TelemetryConfig): TelemetryConfig {
  const mode = resolveDeploymentMode(config.deployment_mode);
  if (mode === "server") {
    return {
      ...config,
      content_cache: { ...config.content_cache, enabled: false },
    };
  }
  return config;
}

function resolveDeploymentMode(mode: TelemetryConfig["deployment_mode"]): "single_user" | "server" {
  if (mode === "single_user") return "single_user";
  if (mode === "server") return "server";
  // auto: check for multi-user indicators (no reliable way without OS context — default single_user)
  return "single_user";
}

// Dot-notation key getter: "content_cache.enabled" → config.content_cache.enabled
export function getConfigKey(config: TelemetryConfig, key: string): unknown {
  const parts = key.split(".");
  let obj: unknown = config;
  for (const part of parts) {
    if (obj == null || typeof obj !== "object") return undefined;
    obj = (obj as Record<string, unknown>)[part];
  }
  return obj;
}

const VALID_KEYS = new Set([
  "content_cache.enabled",
  "content_cache.path",
  "sdk_bridge.enabled",
  "deployment_mode",
]);

// Dot-notation key setter. Returns updated config (does not save).
export function setConfigKey(config: TelemetryConfig, key: string, rawValue: string): TelemetryConfig {
  if (!VALID_KEYS.has(key)) {
    throw new Error(`Unknown config key: "${key}". Valid keys: ${[...VALID_KEYS].join(", ")}`);
  }
  const parts = key.split(".");
  const updated = JSON.parse(JSON.stringify(config)) as TelemetryConfig;
  let obj: Record<string, unknown> = updated as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  // Coerce value types
  if (rawValue === "true") obj[leaf] = true;
  else if (rawValue === "false") obj[leaf] = false;
  else obj[leaf] = rawValue;
  return updated;
}

export function resetConfig(): void {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
}

function mergeConfig(defaults: TelemetryConfig, overrides: Partial<TelemetryConfig>): TelemetryConfig {
  return {
    version: overrides.version ?? defaults.version,
    content_cache: { ...defaults.content_cache, ...(overrides.content_cache ?? {}) },
    sdk_bridge: { ...defaults.sdk_bridge, ...(overrides.sdk_bridge ?? {}) },
    deployment_mode: overrides.deployment_mode ?? defaults.deployment_mode,
  };
}
