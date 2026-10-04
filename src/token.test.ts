import { describe, expect, test } from "bun:test";
import { resolveToken } from "./token";

const authConfig = { tokenEnv: ["ZAI_TOKEN", "Z_AI_TOKEN"], authKeys: ["zai-coding-plan", "zai"] };

function authFile(content: string): (path: string) => string {
  return () => content;
}

function missingFile(): string {
  throw new Error("ENOENT: no such file or directory");
}

describe("resolveToken", () => {
  test("first authKey in order wins from auth.json", () => {
    const json = JSON.stringify({ "zai-coding-plan": { key: "pk-1" }, zai: { key: "pk-2" } });
    expect(resolveToken(authFile(json), "/home/tester", {}, authConfig)).toBe("pk-1");
  });

  test("empty key in first auth entry falls through to next authKey", () => {
    const json = JSON.stringify({ "zai-coding-plan": { key: "" }, zai: { key: "pk-2" } });
    expect(resolveToken(authFile(json), "/home/tester", {}, authConfig)).toBe("pk-2");
  });

  test("whitespace-only key is skipped", () => {
    const json = JSON.stringify({ "zai-coding-plan": { key: "   " }, zai: { key: "pk-2" } });
    expect(resolveToken(authFile(json), "/home/tester", {}, authConfig)).toBe("pk-2");
  });

  test("non-string key values (number, object, null) are skipped", () => {
    const numberKey = JSON.stringify({ "zai-coding-plan": { key: 42 }, zai: { key: "pk-2" } });
    expect(resolveToken(authFile(numberKey), "/home/tester", {}, authConfig)).toBe("pk-2");

    const objectKey = JSON.stringify({ "zai-coding-plan": { key: { nested: true } }, zai: { key: "pk-2" } });
    expect(resolveToken(authFile(objectKey), "/home/tester", {}, authConfig)).toBe("pk-2");

    const nullKey = JSON.stringify({ "zai-coding-plan": { key: null }, zai: { key: "pk-2" } });
    expect(resolveToken(authFile(nullKey), "/home/tester", {}, authConfig)).toBe("pk-2");
  });

  test("missing auth.json (readFile throws) falls back to env token", () => {
    expect(resolveToken(missingFile, "/home/tester", { ZAI_TOKEN: "env-t" }, authConfig)).toBe("env-t");
  });

  test("malformed auth.json falls back to env, first tokenEnv name wins", () => {
    const both = { ZAI_TOKEN: "env-a", Z_AI_TOKEN: "env-b" };
    expect(resolveToken(authFile("{oops"), "/home/tester", both, authConfig)).toBe("env-a");

    const reversed = { tokenEnv: ["Z_AI_TOKEN", "ZAI_TOKEN"], authKeys: authConfig.authKeys };
    expect(resolveToken(authFile("{oops"), "/home/tester", both, reversed)).toBe("env-b");
  });

  test("empty or missing env values are skipped", () => {
    const envWithBlank = { ZAI_TOKEN: "", Z_AI_TOKEN: "pk-env2" };
    expect(resolveToken(authFile("{oops"), "/home/tester", envWithBlank, authConfig)).toBe("pk-env2");

    const envWithUndefined = { ZAI_TOKEN: undefined };
    expect(resolveToken(authFile("{oops"), "/home/tester", envWithUndefined, authConfig)).toBeUndefined();
  });

  test("returns undefined when nothing is found anywhere", () => {
    expect(resolveToken(missingFile, "/home/tester", {}, authConfig)).toBeUndefined();
  });

  test("custom authKeys order is respected", () => {
    const json = JSON.stringify({ "zai-coding-plan": { key: "pk-1" }, zai: { key: "pk-2" } });
    const custom = { tokenEnv: authConfig.tokenEnv, authKeys: ["zai", "zai-coding-plan"] };
    expect(resolveToken(authFile(json), "/home/tester", {}, custom)).toBe("pk-2");
  });

  test("reads exactly <homeDir>/.local/share/opencode/auth.json", () => {
    const calls: string[] = [];
    const readFile = (path: string): string => {
      calls.push(path);
      return JSON.stringify({ zai: { key: "pk-x" } });
    };
    resolveToken(readFile, "/home/tester", {}, authConfig);
    expect(calls).toEqual(["/home/tester/.local/share/opencode/auth.json"]);
  });

  test("auth.json root array is skipped safely to env", () => {
    expect(resolveToken(authFile("[]"), "/home/tester", { ZAI_TOKEN: "env-t" }, authConfig)).toBe("env-t");
    expect(resolveToken(authFile("[]"), "/home/tester", {}, authConfig)).toBeUndefined();
  });

  test("authKey hit whose value is a plain string (not an object) is skipped to env", () => {
    const json = JSON.stringify({ "zai-coding-plan": "pk-plain", zai: { key: "" } });
    expect(resolveToken(authFile(json), "/home/tester", { Z_AI_TOKEN: "env-t" }, authConfig)).toBe("env-t");
  });

  test("auth.json root JSON primitives (number, string, null) fall back to env", () => {
    expect(resolveToken(authFile("42"), "/home/tester", { ZAI_TOKEN: "env-t" }, authConfig)).toBe("env-t");
    expect(resolveToken(authFile('"just a string"'), "/home/tester", { ZAI_TOKEN: "env-t" }, authConfig)).toBe("env-t");
    expect(resolveToken(authFile("null"), "/home/tester", { ZAI_TOKEN: "env-t" }, authConfig)).toBe("env-t");
  });

  test("null config object does not throw and yields undefined", () => {
    expect(
      resolveToken(missingFile, "/home/tester", { ZAI_TOKEN: "env-t" }, null as unknown as typeof authConfig),
    ).toBeUndefined();
  });
});
