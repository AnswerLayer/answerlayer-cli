import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AnswerLayerClient } from "./client.js";
import { readConfig, writeConfig } from "./config.js";

const CORE_REPOSITORY = "https://github.com/AnswerLayer/answerlayer-core.git";
const CORE_REMOTE_PATTERN = /(?:^|@|\/\/)github\.com[:/]AnswerLayer\/answerlayer-core(?:\.git)?\/?$/i;
const REQUIRED_CORE_PATHS = [
  "docker-compose.yml",
  ".env.example",
  "Makefile",
  "backend/app/scripts/bootstrap_local.py",
];

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
  }
  validateCheckout(stackDir, run);

  if (!fs.existsSync(envPath)) {
    prepareEnvironment(stackDir, io.env.ANTHROPIC_API_KEY);
    write(io.stdout, `Created ${envPath} with permissions 0600\n`);
  }

  write(io.stdout, "Starting the local AnswerLayer stack...\n");
  checked(run, "docker", ["compose", "up", "--build", "-d"], { cwd: stackDir, passthrough: true });
  const publishedPort = checked(
    run,
    "docker",
    ["compose", "port", "answerlayer", "8000"],
    { cwd: stackDir },
  );
  const baseUrl = parsePublishedBaseUrl(publishedPort.stdout);
  await waitUntilHealthy(baseUrl, io);

  write(io.stdout, "Creating a local CLI identity and rotating its scoped key...\n");
  const bootstrap = checked(run, "make", ["local-bootstrap"], { cwd: stackDir });
  const credentials = { baseUrl, apiKey: parseBootstrapApiKey(bootstrap.stdout) };

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
  const template = fs.readFileSync(examplePath, "utf8");
  const replacements = {
    ANTHROPIC_API_KEY: anthropicApiKey,
    ENCRYPTION_KEY: encryptionKey,
  };
  let contents = template;
  for (const [name, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`^${name}=.*$`, "gm");
    if ([...template.matchAll(pattern)].length !== 1) {
      throw new Error(`${examplePath} must contain exactly one ${name}= entry`);
    }
    contents = contents.replace(pattern, () => `${name}=${value}`);
  }
  const envPath = path.join(stackDir, ".env");
  fs.writeFileSync(envPath, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

function validateCheckout(stackDir, run) {
  if (!fs.existsSync(path.join(stackDir, ".git"))) {
    throw new Error(`${stackDir} is not a Git checkout`);
  }
  for (const relativePath of REQUIRED_CORE_PATHS) {
    if (!fs.existsSync(path.join(stackDir, relativePath))) {
      throw new Error(`${stackDir} is missing required AnswerLayer core file ${relativePath}`);
    }
  }

  const remote = checked(run, "git", ["-C", stackDir, "remote", "get-url", "origin"]);
  if (!CORE_REMOTE_PATTERN.test(String(remote.stdout).trim())) {
    throw new Error(`${stackDir} does not use the official AnswerLayer core origin`);
  }
}

function parsePublishedBaseUrl(stdout) {
  const publishedAddress = String(stdout)
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /^(?:0\.0\.0\.0|127\.0\.0\.1|localhost|\[::\]|::):\d+$/.test(line));
  const port = publishedAddress
    ? Number.parseInt(publishedAddress.slice(publishedAddress.lastIndexOf(":") + 1), 10)
    : 0;
  if (port < 1 || port > 65535) {
    throw new Error("Docker Compose did not publish answerlayer port 8000 on a local host interface");
  }
  return `http://127.0.0.1:${port}`;
}

async function waitUntilHealthy(baseUrl, io) {
  const fetchImpl = io.fetch || globalThis.fetch;
  const sleep = io.sleep || ((milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const attempts = io.healthAttempts || 60;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The container may still be starting.
    }
    await sleep(2000);
  }
  throw new Error(`Local stack did not become healthy at ${baseUrl}/healthz`);
}

function parseBootstrapApiKey(stdout) {
  const initLine = String(stdout).split(/\r?\n/).find(line => /(?:^|\s)answerlayer\s+init(?:\s|$)/.test(line));
  const match = initLine?.match(/(?:^|\s)--api-key(?:=|\s+)(\S+)/);
  if (!match) throw new Error("Local bootstrap completed without returning CLI credentials");
  return match[1];
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
