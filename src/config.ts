export type QuotaConfig = {
  intervalMs: number;
  endpoint: string;
  timeoutMs: number;
  gaugeWidth: number;
  warnThreshold: number;
  critThreshold: number;
  panel: boolean;
  chip: boolean;
  showRunway: boolean;
  maxHistory: number;
  tokenEnv: string[];
  authKeys: string[];
};

export const DEFAULT_CONFIG: Readonly<QuotaConfig> = {
  intervalMs: 60000,
  endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
  timeoutMs: 8000,
  gaugeWidth: 12,
  warnThreshold: 0.7,
  critThreshold: 0.9,
  panel: true,
  chip: true,
  showRunway: true,
  maxHistory: 120,
  tokenEnv: ["ZAI_TOKEN", "Z_AI_TOKEN"],
  authKeys: ["zai-coding-plan", "zai"],
};

const NUMERIC_KEYS = [
  "intervalMs",
  "timeoutMs",
  "gaugeWidth",
  "warnThreshold",
  "critThreshold",
  "maxHistory",
] as const;
type NumericKey = (typeof NUMERIC_KEYS)[number];

const BOOLEAN_KEYS = ["panel", "chip", "showRunway"] as const;
type BooleanKey = (typeof BOOLEAN_KEYS)[number];

const LIST_KEYS = ["tokenEnv", "authKeys"] as const;
type ListKey = (typeof LIST_KEYS)[number];

type ConfigKey = NumericKey | BooleanKey | "endpoint" | ListKey;

const ENV_TO_KEY: Readonly<Record<string, ConfigKey>> = {
  ZAI_QUOTA_INTERVAL_MS: "intervalMs",
  ZAI_QUOTA_ENDPOINT: "endpoint",
  ZAI_QUOTA_TIMEOUT_MS: "timeoutMs",
  ZAI_QUOTA_GAUGE_WIDTH: "gaugeWidth",
  ZAI_QUOTA_WARN: "warnThreshold",
  ZAI_QUOTA_CRIT: "critThreshold",
  ZAI_QUOTA_PANEL: "panel",
  ZAI_QUOTA_CHIP: "chip",
  ZAI_QUOTA_RUNWAY: "showRunway",
  ZAI_QUOTA_MAX_HISTORY: "maxHistory",
};

const TRUE_STRINGS = new Set(["1", "true", "yes"]);
const FALSE_STRINGS = new Set(["0", "false", "no"]);

function toFiniteNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof raw !== "number") return undefined;
  return Number.isFinite(raw) ? raw : undefined;
}

export function resolveConfig(
  env: Record<string, string | undefined>,
  options?: Partial<Record<keyof QuotaConfig, unknown>>,
): { config: QuotaConfig; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    warnings.push(message);
  };

  const config: QuotaConfig = {
    ...DEFAULT_CONFIG,
    tokenEnv: [...DEFAULT_CONFIG.tokenEnv],
    authKeys: [...DEFAULT_CONFIG.authKeys],
  };

  const applyNumeric = (key: NumericKey, raw: unknown): void => {
    const parsed = toFiniteNumber(raw);
    if (parsed === undefined) {
      warn(`invalid ${key}, using ${config[key]}`);
      return;
    }
    config[key] = parsed;
  };

  const applyBooleanEnv = (key: BooleanKey, raw: unknown): void => {
    if (typeof raw !== "string") {
      warn(`invalid ${key}, using ${config[key]}`);
      return;
    }
    const normalized = raw.trim().toLowerCase();
    if (TRUE_STRINGS.has(normalized)) {
      config[key] = true;
      return;
    }
    if (FALSE_STRINGS.has(normalized)) {
      config[key] = false;
      return;
    }
    warn(`invalid ${key}, using ${config[key]}`);
  };

  const applyBooleanOption = (key: BooleanKey, raw: unknown): void => {
    if (raw === true) {
      config[key] = true;
      return;
    }
    if (raw === false) {
      config[key] = false;
      return;
    }
    warn(`invalid ${key}, using ${config[key]}`);
  };

  const applyEndpoint = (raw: unknown): void => {
    if (typeof raw === "string" && raw.trim() !== "") {
      config.endpoint = raw;
      if (!raw.trim().toLowerCase().startsWith("https://")) {
        warn("endpoint is not https, token will be sent over an insecure connection");
      }
      return;
    }
    warn(`invalid endpoint, using ${config.endpoint}`);
  };

  const applyList = (key: ListKey, raw: unknown): void => {
    if (Array.isArray(raw)) {
      const filtered = raw.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      if (filtered.length >= 1) {
        config[key] = filtered;
        return;
      }
    }
    warn(`invalid ${key}, using defaults`);
  };

  const isNumericKey = (key: ConfigKey): key is NumericKey =>
    (NUMERIC_KEYS as readonly string[]).includes(key);
  const isBooleanKey = (key: ConfigKey): key is BooleanKey =>
    (BOOLEAN_KEYS as readonly string[]).includes(key);
  const isListKey = (key: ConfigKey): key is ListKey =>
    (LIST_KEYS as readonly string[]).includes(key);

  // Layer 2: environment variables (exact name mapping).
  for (const [envName, key] of Object.entries(ENV_TO_KEY)) {
    const raw = env[envName];
    if (raw === undefined) continue;
    if (isNumericKey(key)) {
      applyNumeric(key, raw);
      continue;
    }
    if (isBooleanKey(key)) {
      applyBooleanEnv(key, raw);
      continue;
    }
    if (key === "endpoint") {
      applyEndpoint(raw);
      continue;
    }
    // List keys (tokenEnv/authKeys) have no env mapping.
  }

  // Layer 3: options object (later wins over env).
  if (options !== null && typeof options === "object") {
    for (const key of Object.keys(options) as (keyof QuotaConfig)[]) {
      const known = key as ConfigKey;
      if (!isNumericKey(known) && !isBooleanKey(known) && known !== "endpoint" && !isListKey(known)) {
        continue;
      }
      const raw: unknown = options[key];
      if (isNumericKey(known)) {
        applyNumeric(known, raw);
        continue;
      }
      if (isBooleanKey(known)) {
        applyBooleanOption(known, raw);
        continue;
      }
      if (known === "endpoint") {
        applyEndpoint(raw);
        continue;
      }
      applyList(known, raw);
    }
  }

  // Rule 3: clamps after all layers.
  const clamp = (key: NumericKey, value: number): void => {
    if (config[key] !== value) {
      config[key] = value;
      warn(`clamped ${key} to ${value}`);
    }
  };
  clamp("intervalMs", Math.min(2 ** 31 - 1, Math.max(10000, config.intervalMs)));
  clamp("timeoutMs", Math.min(60000, Math.max(1000, config.timeoutMs)));
  clamp("gaugeWidth", Math.floor(Math.min(40, Math.max(4, config.gaugeWidth))));
  clamp("maxHistory", Math.min(1000, Math.max(2, Math.floor(config.maxHistory))));

  // Rule 4: thresholds must satisfy 0 < warn < crit <= 1.
  const warnThreshold = config.warnThreshold;
  const critThreshold = config.critThreshold;
  const thresholdsValid =
    Number.isFinite(warnThreshold) &&
    Number.isFinite(critThreshold) &&
    warnThreshold > 0 &&
    warnThreshold < critThreshold &&
    critThreshold <= 1;
  if (!thresholdsValid) {
    config.warnThreshold = DEFAULT_CONFIG.warnThreshold;
    config.critThreshold = DEFAULT_CONFIG.critThreshold;
    warn("invalid thresholds, using defaults");
  }

  return { config, warnings };
}
