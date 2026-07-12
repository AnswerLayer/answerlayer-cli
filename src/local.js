import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AnswerLayerClient } from "./client.js";
import { readConfig, writeConfig } from "./config.js";

const CORE_REPOSITORY = "https://github.com/AnswerLayer/answerlayer-core.git";
const LOCAL_BASE_URL = "http://localhost:8000";

export async function localUp(parsed, io) {
  const stackDir = path.resolve(firstValue(parsed.flags.stackDir) || path.join(os.homedir(), ".answerlayer", "core"));
  const envPath = path.join(stackDir, ".env");
  const run = io.runCommand || runCommand;

  requireCommand(run, "git", ["--version"]);
  requireCommand(run, "docker", ["compose", "version"]);

  const stackExists = fs.existsSync(stackDir);
  if (!fs.existsSync(envPath) && !io.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Set ANTHROPIC_API_KEY in your environment before the first `answerlayer local up`. It is written only to the local stack's permission-restricted .env file.",
    );
  }

  if (!stackExists) {
    fs.mkdirSync(path.dirname(stackDir), { recursive: true, mode: 0o700 });
    write(io.stdout, `Cloning the AnswerLayer stack into ${stackDir}\n`);
    checked(run, "git", ["clone", "--depth", "1", CORE_REPOSITORY, stackDir]);
  } else if (!fs.existsSync(path.join(stackDir, ".git")) || !fs.existsSync(path.join(stackDir, "docker-compose.yml"))) {
    throw new Error(`${stackDir} exists but is not an AnswerLayer core checkout`);
  }

  if (!fs.existsSync(envPath)) {
    prepareEnvironment(stackDir, io.env.ANTHROPIC_API_KEY);
    write(io.stdout, `Created ${envPath} with permissions 0600\n`);
  }

  write(io.stdout, "Starting the local AnswerLayer stack...\n");
  checked(run, "docker", ["compose", "up", "--build", "-d"], { cwd: stackDir, passthrough: true });
  await waitUntilHealthy(io);

  write(io.stdout, "Creating a local CLI identity and rotating its scoped key...\n");
  const bootstrap = checked(run, "make", ["local-bootstrap"], { cwd: stackDir });
  const credentials = parseBootstrap(bootstrap.stdout);

  const client = new AnswerLayerClient({ ...credentials, fetchImpl: io.fetch || globalThis.fetch });
  await client.rawRequest("GET", "/api/v1/auth/me");

  const existing = readConfig(io.env);
  const configPath = writeConfig({ ...existing, ...credentials }, io.env);
  write(io.stdout, `Local AnswerLayer is ready. Verified credentials and saved config to ${configPath}\n`);
  write(io.stdout, "Next: answerlayer connections list\n");
}

function prepareEnvironment(stackDir, anthropicApiKey) {
  const examplePath = path.join(stackDir, ".env.example");
  if (!fs.existsSync(examplePath)) throw new Error(`Missing ${examplePath}`);

  if (/[\r\n]/.test(anthropicApiKey)) throw new Error("ANTHROPIC_API_KEY must not contain a newline");
  const encryptionKey = crypto.randomBytes(32).toString("hex");
  const contents = fs.readFileSync(examplePath, "utf8")
    .replace(/^ANTHROPIC_API_KEY=.*$/m, () => `ANTHROPIC_API_KEY=${anthropicApiKey}`)
    .replace(/^ENCRYPTION_KEY=.*$/m, () => `ENCRYPTION_KEY=${encryptionKey}`);
  const envPath = path.join(stackDir, ".env");
  fs.writeFileSync(envPath, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

async function waitUntilHealthy(io) {
  const fetchImpl = io.fetch || globalThis.fetch;
  const sleep = io.sleep || ((milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const attempts = io.healthAttempts || 60;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${LOCAL_BASE_URL}/healthz`);
      if (response.ok) return;
    } catch {
      // The container may still be starting.
    }
    await sleep(2000);
  }
  throw new Error(`Local stack did not become healthy at ${LOCAL_BASE_URL}/healthz`);
}

function parseBootstrap(stdout) {
  const match = stdout.match(/answerlayer init --base-url (\S+) --api-key (\S+)/);
  if (!match) throw new Error("Local bootstrap completed without returning CLI credentials");
  return { baseUrl: match[1], apiKey: match[2] };
}

function requireCommand(run, command, args) {
  const result = run(command, args, { capture: true });
  if (result.error?.code === "ENOENT") throw new Error(`${command} is required for local setup`);
  if (result.status !== 0) throw new Error(`${command} is required for local setup`);
}

function checked(run, command, args, options = {}) {
  const result = run(command, args, { capture: !options.passthrough, cwd: options.cwd });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function write(stream, text) {
  stream.write(text);
}
