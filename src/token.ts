export function resolveToken(
  readFile: (path: string) => string,
  homeDir: string,
  env: Record<string, string | undefined>,
  config: { tokenEnv: string[]; authKeys: string[] },
): string | undefined {
  const authKeys: string[] = Array.isArray(config?.authKeys) ? config.authKeys : [];
  const tokenEnv: string[] = Array.isArray(config?.tokenEnv) ? config.tokenEnv : [];

  let auth: unknown;
  try {
    const raw = readFile(homeDir + "/.local/share/opencode/auth.json");
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        auth = parsed;
      }
    } catch {
      // Malformed auth.json: fall through to env lookup.
    }
  } catch {
    // Unreadable auth.json (ENOENT etc.): fall through to env lookup.
  }

  if (typeof auth === "object" && auth !== null) {
    const record = auth as Record<string, unknown>;
    for (const authKey of authKeys) {
      const entry: unknown = record[authKey];
      if (typeof entry === "object" && entry !== null) {
        const inner = entry as Record<string, unknown>;
        if (typeof inner.key === "string" && inner.key.trim() !== "") {
          return inner.key;
        }
      }
    }
  }

  for (const envName of tokenEnv) {
    const value = env[envName];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}
