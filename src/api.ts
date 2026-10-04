export type QuotaRow = {
  label: string;
  usage: number | null;
  limit: number | null;
  percent: number | null;
  resetAt: number | null;
};

export type ParsedQuota = { rows: QuotaRow[]; level: string | null };

export type FetchResult = { ok: true; payload: unknown } | { ok: false; error: string };

const SCAN_FIELDS = ["usage", "currentValue", "remaining", "percentage", "nextResetTime"] as const;
const MAX_SCAN_DEPTH = 6;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function entryLabel(entry: Record<string, unknown>): string {
  if (entry.unit === 3) return "5h";
  if (entry.unit === 6) return "wk";
  return typeof entry.type === "string" && entry.type !== "" ? entry.type : "quota";
}

function mapEntry(entry: Record<string, unknown>): QuotaRow {
  const currentValue = finiteNumber(entry.currentValue);
  const usageField = finiteNumber(entry.usage);
  const usage =
    currentValue !== undefined ? currentValue : usageField !== undefined ? usageField : null;

  const remaining = finiteNumber(entry.remaining);
  let limit: number | null = null;
  if (usage !== null && remaining !== undefined) {
    const sum = usage + remaining;
    if (Number.isFinite(sum)) limit = sum;
  }

  const percentage = finiteNumber(entry.percentage);
  let percent: number | null = null;
  if (percentage !== undefined) {
    percent = Math.min(100, Math.max(0, percentage));
  } else if (usage !== null && limit !== null && limit > 0) {
    percent = (usage / limit) * 100;
  }

  const nextReset = finiteNumber(entry.nextResetTime);

  return {
    label: entryLabel(entry),
    usage,
    limit,
    percent,
    resetAt: nextReset !== undefined ? nextReset : null,
  };
}

function extractData(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return null;
  return data as Record<string, unknown>;
}

function extractLevel(payload: unknown): string | null {
  const data = extractData(payload);
  if (data === null) return null;
  const level = data.level;
  return typeof level === "string" && level !== "" ? level : null;
}

function isEntryObject(entry: unknown): entry is Record<string, unknown> {
  if (typeof entry !== "object" || entry === null) return false;
  return Object.keys(entry).length > 0;
}

function scanForRows(node: unknown, depth: number, visited: Set<object>, rows: QuotaRow[]): void {
  if (depth > MAX_SCAN_DEPTH) return;
  if (typeof node !== "object" || node === null) return;
  if (visited.has(node)) return;
  visited.add(node);

  if (Array.isArray(node)) {
    for (const item of node) {
      scanForRows(item, depth + 1, visited, rows);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  const numericCount = SCAN_FIELDS.filter((field) => finiteNumber(record[field]) !== undefined).length;
  if (numericCount >= 2) {
    rows.push(mapEntry(record));
  }
  for (const value of Object.values(record)) {
    scanForRows(value, depth + 1, visited, rows);
  }
}

export function parseQuota(payload: unknown): ParsedQuota {
  const level = extractLevel(payload);
  const rows: QuotaRow[] = [];

  const data = extractData(payload);
  const limits = data === null ? undefined : data.limits;

  if (Array.isArray(limits) && limits.length > 0) {
    for (const entry of limits) {
      if (isEntryObject(entry)) {
        rows.push(mapEntry(entry));
      }
    }
    return { rows, level };
  }

  scanForRows(payload, 0, new Set<object>(), rows);
  return { rows, level };
}

export async function fetchQuota(
  fetchImpl: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{ status: number; text: string }>,
  token: string,
  config: { endpoint: string; timeoutMs: number },
): Promise<FetchResult> {
  const controller = new AbortController();
  const timeoutMs =
    typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) ? config.timeoutMs : 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("timeout")));
  });

  try {
    const response = await Promise.race([
      fetchImpl(config.endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    if (response.status >= 400) {
      return { ok: false, error: `http-${response.status}` };
    }

    try {
      const payload: unknown = JSON.parse(response.text);
      return { ok: true, payload };
    } catch {
      return { ok: false, error: "bad-json" };
    }
  } catch {
    if (controller.signal.aborted) {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "network" };
  } finally {
    clearTimeout(timer);
  }
}
