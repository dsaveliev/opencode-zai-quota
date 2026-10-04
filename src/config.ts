export type QuotaConfig = {
  intervalMs: number;
  endpoint: string;
  timeoutMs: number;
  gaugeWidth: number;
  panel: boolean;
  chip: boolean;
  maxHistory: number;
  /** Tight-band multiplier for the V2 verdict ladder; validated >= 1. */
  tightFactor: number;
  /** Glyph vocabulary for the V2 renderer. */
  glyphs: "unicode" | "ascii";
  /** Whether the per-window detail line is always shown or auto-degraded. */
  detail: "always" | "auto";
  tokenEnv: string[];
  authKeys: string[];
};

export const DEFAULT_CONFIG: Readonly<QuotaConfig> = {
  intervalMs: 60000,
  endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
  timeoutMs: 8000,
  gaugeWidth: 16,
  panel: true,
  chip: true,
  maxHistory: 120,
  tightFactor: 1.5,
  glyphs: "unicode",
  detail: "always",
  tokenEnv: ["ZAI_TOKEN", "Z_AI_TOKEN"],
  authKeys: ["zai-coding-plan", "zai"],
};

const NUMERIC_KEYS = [
  "intervalMs",
  "timeoutMs",
  "gaugeWidth",
  "maxHistory",
  "tightFactor",
] as const;
type NumericKey = (typeof NUMERIC_KEYS)[number];

const BOOLEAN_KEYS = ["panel", "chip"] as const;
type BooleanKey = (typeof BOOLEAN_KEYS)[number];

const ENUM_KEYS = ["glyphs", "detail"] as const;
type EnumKey = (typeof ENUM_KEYS)[number];

const ENUM_VALUES: Record<EnumKey, readonly string[]> = {
  glyphs: ["unicode", "ascii"],
  detail: ["always", "auto"],
};

const LIST_KEYS = ["tokenEnv", "authKeys"] as const;
type ListKey = (typeof LIST_KEYS)[number];

type ConfigKey = NumericKey | BooleanKey | "endpoint" | EnumKey | ListKey;

const ENV_TO_KEY: Readonly<Record<string, ConfigKey>> = {
  ZAI_QUOTA_INTERVAL_MS: "intervalMs",
  ZAI_QUOTA_ENDPOINT: "endpoint",
  ZAI_QUOTA_TIMEOUT_MS: "timeoutMs",
  ZAI_QUOTA_GAUGE_WIDTH: "gaugeWidth",
  ZAI_QUOTA_PANEL: "panel",
  ZAI_QUOTA_CHIP: "chip",
  ZAI_QUOTA_MAX_HISTORY: "maxHistory",
  ZAI_QUOTA_TIGHT_FACTOR: "tightFactor",
  ZAI_QUOTA_GLYPHS: "glyphs",
  ZAI_QUOTA_DETAIL: "detail",
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

  /** String-enum key: exact value (case-insensitive, trimmed) or default + warning. */
  const applyEnum = (key: EnumKey, raw: unknown): void => {
    if (typeof raw === "string" && ENUM_VALUES[key].includes(raw.trim().toLowerCase())) {
      const normalized = raw.trim().toLowerCase();
      if (key === "glyphs") config.glyphs = normalized as QuotaConfig["glyphs"];
      else config.detail = normalized as QuotaConfig["detail"];
      return;
    }
    warn(`invalid ${key}, using ${config[key]}`);
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
  const isEnumKey = (key: ConfigKey): key is EnumKey =>
    (ENUM_KEYS as readonly string[]).includes(key);
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
    if (isEnumKey(key)) {
      applyEnum(key, raw);
      continue;
    }
    // List keys (tokenEnv/authKeys) have no env mapping.
  }

  // Layer 3: options object (later wins over env).
  if (options !== null && typeof options === "object") {
    for (const key of Object.keys(options) as (keyof QuotaConfig)[]) {
      const known = key as ConfigKey;
      if (
        !isNumericKey(known) &&
        !isBooleanKey(known) &&
        known !== "endpoint" &&
        !isEnumKey(known) &&
        !isListKey(known)
      ) {
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
      if (isEnumKey(known)) {
        applyEnum(known, raw);
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

  // Rule 4: tightFactor must be finite and >= 1 (status.ts tight-band contract).
  if (!Number.isFinite(config.tightFactor) || config.tightFactor < 1) {
    config.tightFactor = DEFAULT_CONFIG.tightFactor;
    warn(`invalid tightFactor, using ${DEFAULT_CONFIG.tightFactor}`);
  }

  return { config, warnings };
}
