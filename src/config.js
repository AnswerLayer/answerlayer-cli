import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Default to the hosted AnswerLayer SaaS. Override with --base-url, the
// ANSWERLAYER_BASE_URL env var, or `answerlayer configure` for BYOC /
// self-hosted installs.
export const DEFAULT_BASE_URL = "https://app.answerlayer.io";

export function defaultConfigPath(env = process.env) {
  return env.ANSWERLAYER_CONFIG || path.join(os.homedir(), ".answerlayer", "config.json");
}

export function readConfig(env = process.env) {
  const configPath = defaultConfigPath(env);
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = fs.readFileSync(configPath, "utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid config JSON at ${configPath}: ${error.message}`);
  }
}

export function writeConfig(config, env = process.env) {
  const configPath = defaultConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return configPath;
}

export function resolveAuth(options, env = process.env) {
  const fileConfig = readConfig(env);
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || env.ANSWERLAYER_BASE_URL || fileConfig.baseUrl || DEFAULT_BASE_URL,
  );
  const apiKey = options.apiKey || env.ANSWERLAYER_API_KEY || fileConfig.apiKey;

  return { baseUrl, apiKey };
}

export function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return undefined;
  }

  return String(baseUrl).replace(/\/+$/, "");
}
