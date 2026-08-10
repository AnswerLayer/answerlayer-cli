import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AnswerLayerClient } from "./client.js";
import { defaultConfigPath, readConfig, writeConfig } from "./config.js";

export const DEFAULT_LOCAL_IMAGE = "public.ecr.aws/s8d9x7y7/answerlayer:1.19.9";
const DEFAULT_PORT = 8000;
const MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const PROJECT_NAME = "answerlayer-local";

export async function handleLocal(command, parsed, io) {
  if (command === "init") return localInit(parsed, io);
  if (command === "start" || command === "up") return localStart(parsed, io);
  if (command === "status") return localStatus(parsed, io);
  if (command === "logs") return localLogs(parsed, io);
  if (command === "stop") return localStop(parsed, io);
  if (command === "upgrade") return localUpgrade(parsed, io);
  if (command === "reset") return localReset(parsed, io);
  throw new Error("Expected `answerlayer local init|start|status|logs|stop|upgrade|reset`");
}

export async function localUp(parsed, io) {
  return localStart(parsed, io);
}

async function localInit(parsed, io) {
  const runtime = await ensureInitialized(parsed, io);
  printRuntimeSummary(runtime, io, "Local AnswerLayer is initialized.");
  write(io.stdout, "Next: answerlayer local start\n");
}

async function localStart(parsed, io) {
  const run = io.runCommand || runCommand;
  const runtime = await ensureInitialized(parsed, io);
  const before = inspectStatus(runtime, run);

  if (before.status === "stopped" && !(await portIsAvailable(runtime.state.port, io))) {
    throw new Error(
      `Port ${runtime.state.port} is already in use. Stop the process using it or choose another port with --port <port>.`,
    );
  }

  write(io.stdout, `Starting AnswerLayer ${runtime.state.resolvedImage}...\n`);
  try {
    checked(run, "docker", [...composeArgs(runtime), "up", "--detach", "--wait", "--wait-timeout", "180"]);
  } catch (error) {
    const status = inspectStatus(runtime, run, { tolerateFailure: true });
    const hint = status.status === "failed"
      ? " Inspect `answerlayer local logs` for the migration or application error."
      : " Check Docker Desktop/Engine and retry.";
    throw new Error(`Local stack failed to start: ${error.message}.${hint}`);
  }

  const baseUrl = `http://127.0.0.1:${runtime.state.port}`;
  await waitUntilReady(baseUrl, io);
  const configPath = await ensureLocalCredentials(runtime, baseUrl, io);
  const state = { ...runtime.state, lastStatus: "ready", updatedAt: new Date().toISOString() };
  writeState(runtime.statePath, state);

  printRuntimeSummary({ ...runtime, state }, io, "Local AnswerLayer is ready.");
  write(io.stdout, `CLI config: ${configPath}\n`);
  write(io.stdout, "Next: answerlayer connections list\n");
}

async function localUpgrade(parsed, io) {
  const image = firstValue(parsed.flags.image) || io.env.ANSWERLAYER_LOCAL_IMAGE || DEFAULT_LOCAL_IMAGE;
  write(io.stdout, `Upgrading the local runtime to ${image}...\n`);
  return localStart({ ...parsed, flags: { ...parsed.flags, image, forcePull: true } }, io);
}

async function localStatus(parsed, io) {
  const run = io.runCommand || runCommand;
  const runtime = loadRuntime(parsed, io);
  requireCommand(run, "docker", ["compose", "version"]);
  const status = inspectStatus(runtime, run, { tolerateFailure: true });
  const result = {
    status: status.status,
    url: `http://127.0.0.1:${runtime.state.port}`,
    image: runtime.state.requestedImage,
    resolvedImage: runtime.state.resolvedImage,
    runtimeDirectory: runtime.directory,
    services: status.services,
  };

  if (parsed.flags.json) {
    write(io.stdout, `${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  write(io.stdout, `Status: ${result.status}\n`);
  write(io.stdout, `URL: ${result.url}\n`);
  write(io.stdout, `Image: ${result.resolvedImage}\n`);
  write(io.stdout, `Runtime config: ${result.runtimeDirectory}\n`);
}

async function localLogs(parsed, io) {
  const run = io.runCommand || runCommand;
  const runtime = loadRuntime(parsed, io);
  requireCommand(run, "docker", ["compose", "version"]);
  const args = [...composeArgs(runtime), "logs"];
  if (parsed.flags.follow) args.push("--follow");
  args.push("--tail", String(firstValue(parsed.flags.tail) || 100));
  const service = parsed.positionals[2];
  if (service) args.push(service);
  checked(run, "docker", args, { passthrough: true });
}

async function localStop(parsed, io) {
  const run = io.runCommand || runCommand;
  const runtime = loadRuntime(parsed, io);
  requireCommand(run, "docker", ["compose", "version"]);
  checked(run, "docker", [...composeArgs(runtime), "down"], { passthrough: true });
  writeState(runtime.statePath, { ...runtime.state, lastStatus: "stopped", updatedAt: new Date().toISOString() });
  write(io.stdout, "Local AnswerLayer stopped. Persistent data was preserved.\n");
  write(io.stdout, "Resume with: answerlayer local start\n");
}

async function localReset(parsed, io) {
  if (!parsed.flags.force) {
    throw new Error(
      "Reset permanently deletes the local AnswerLayer database. Rerun with `answerlayer local reset --force` to confirm.",
    );
  }
  const run = io.runCommand || runCommand;
  const runtime = loadRuntime(parsed, io);
  requireCommand(run, "docker", ["compose", "version"]);
  checked(run, "docker", [...composeArgs(runtime), "down", "--volumes", "--remove-orphans"], { passthrough: true });
  writeState(runtime.statePath, { ...runtime.state, lastStatus: "stopped", resetAt: new Date().toISOString() });
  write(io.stdout, "Deleted the local AnswerLayer database volume. Runtime configuration was preserved.\n");
  write(io.stdout, "Create a fresh database with: answerlayer local start\n");
}

async function ensureInitialized(parsed, io) {
  const run = io.runCommand || runCommand;
  const runtime = runtimePaths(parsed, io);
  fs.mkdirSync(runtime.directory, { recursive: true, mode: 0o700 });

  preflight(run, runtime.directory, io);

  const existingState = readState(runtime.statePath);
  const explicitImage = firstValue(parsed.flags.image) || io.env.ANSWERLAYER_LOCAL_IMAGE;
  const requestedImage = explicitImage || existingState?.requestedImage || DEFAULT_LOCAL_IMAGE;
  const port = parsePort(firstValue(parsed.flags.port) || existingState?.port || DEFAULT_PORT);
  const needsPull = parsed.flags.forcePull
    || !existingState?.resolvedImage
    || requestedImage !== existingState.requestedImage;

  let resolvedImage = existingState?.resolvedImage;
  if (needsPull) {
    write(io.stdout, `Pulling ${requestedImage} from the public registry...\n`);
    try {
      checked(run, "docker", ["pull", requestedImage]);
      resolvedImage = resolveDigest(run, requestedImage);
    } catch (error) {
      throw new Error(
        `Could not pull the public AnswerLayer image ${requestedImage}: ${error.message}. Check network access and the image version, then retry.`,
      );
    }
  }

  const state = {
    schemaVersion: 1,
    requestedImage,
    resolvedImage,
    port,
    createdAt: existingState?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastStatus: existingState?.lastStatus || "stopped",
  };

  writeCompose(runtime.composePath);
  writeEnvironment(runtime.envPath, state);
  writeState(runtime.statePath, state);
  return { ...runtime, state };
}

function preflight(run, directory, io) {
  requireCommand(run, "docker", ["compose", "version"]);
  const dockerVersion = checked(run, "docker", ["version", "--format", "{{.Server.Version}}"]).stdout.trim();
  requireMinimumVersion(dockerVersion, [20, 10], "Docker Engine");
  const composeVersion = checked(run, "docker", ["compose", "version", "--short"]).stdout.trim();
  requireMinimumVersion(composeVersion, [2, 20], "Docker Compose");

  const engine = checked(run, "docker", ["info", "--format", "{{.OSType}}/{{.Architecture}}"]).stdout.trim();
  if (!/^linux\/(amd64|x86_64|arm64|aarch64)$/.test(engine)) {
    throw new Error(`Unsupported Docker platform ${engine || "unknown"}. AnswerLayer supports linux/amd64 and linux/arm64 containers.`);
  }

  const availableBytes = io.availableBytes ?? freeBytes(directory);
  if (availableBytes < MINIMUM_FREE_BYTES) {
    throw new Error("AnswerLayer local setup requires at least 2 GB of free disk space for images and persistent data.");
  }
}

function requireMinimumVersion(raw, minimum, label) {
  const match = String(raw).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) throw new Error(`Could not determine ${label} version from ${raw || "empty output"}`);
  const current = match.slice(1, 4).map(value => Number.parseInt(value || "0", 10));
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return;
    if (current[index] < minimum[index]) {
      throw new Error(`${label} ${minimum.join(".")} or newer is required; found ${raw}`);
    }
  }
}

function resolveDigest(run, requestedImage) {
  const inspected = checked(
    run,
    "docker",
    ["image", "inspect", "--format", "{{json .RepoDigests}}", requestedImage],
  ).stdout.trim();
  let digests;
  try {
    digests = JSON.parse(inspected);
  } catch {
    throw new Error("Docker did not return parseable image digest metadata");
  }
  const repository = imageRepository(requestedImage);
  const resolved = digests.find(item => String(item).startsWith(`${repository}@sha256:`));
  if (!resolved) throw new Error("Docker did not return an immutable digest for the pulled image");
  return resolved;
}

function imageRepository(image) {
  const withoutDigest = String(image).split("@")[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

async function ensureLocalCredentials(runtime, baseUrl, io) {
  const existing = readConfig(io.env);
  const fetchImpl = io.fetch || globalThis.fetch;
  if (existing.baseUrl === baseUrl && existing.apiKey) {
    const client = new AnswerLayerClient({ baseUrl, apiKey: existing.apiKey, fetchImpl });
    try {
      await client.rawRequest("GET", "/api/v1/auth/me");
      return defaultConfigPath(io.env);
    } catch {
      // The database may have been reset. Bootstrap a replacement local key.
    }
  }

  write(io.stdout, "Creating a local-only CLI identity...\n");
  const run = io.runCommand || runCommand;
  let bootstrap;
  try {
    bootstrap = checked(run, "docker", [
      ...composeArgs(runtime),
      "exec", "-T", "answerlayer", "python", "-m", "app.scripts.bootstrap_local",
    ]);
  } catch (error) {
    throw new Error(`Local credential bootstrap failed: ${error.message}. Run \`answerlayer local logs answerlayer\` for details.`);
  }
  const credentials = { baseUrl, apiKey: parseBootstrapApiKey(bootstrap.stdout) };
  const configPath = writeConfig({ ...existing, ...credentials }, io.env);
  const client = new AnswerLayerClient({ ...credentials, fetchImpl });
  try {
    await client.rawRequest("GET", "/api/v1/auth/me");
  } catch (error) {
    throw new Error(`Saved local credentials to ${configPath}, but verification failed: ${error.message}`);
  }
  return configPath;
}

async function waitUntilReady(baseUrl, io) {
  const fetchImpl = io.fetch || globalThis.fetch;
  const sleep = io.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const attempts = io.healthAttempts || 60;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}/readyz`);
      if (response.ok) return;
    } catch {
      // Docker may have reported healthy just before the host port was reachable.
    }
    await sleep(2000);
  }
  throw new Error(`AnswerLayer did not become ready at ${baseUrl}/readyz. Run \`answerlayer local logs\` for details.`);
}

function inspectStatus(runtime, run, options = {}) {
  const result = run("docker", [...composeArgs(runtime), "ps", "--all", "--format", "json"], { capture: true });
  if (result.error || result.status !== 0) {
    if (options.tolerateFailure) return { status: "failed", services: [] };
    throw new Error("Could not inspect the local Docker Compose stack");
  }
  const services = parseComposePs(result.stdout);
  const migrate = services.find(service => String(service.Service).toLowerCase() === "migrate");
  const app = services.find(service => String(service.Service).toLowerCase() === "answerlayer");
  const state = value => String(value || "").toLowerCase();

  if ([migrate, app].some(service => service && (state(service.Health) === "unhealthy" || (state(service.State) === "exited" && Number(service.ExitCode) !== 0)))) {
    return { status: "failed", services };
  }
  if (migrate && state(migrate.State) === "running") return { status: "migrating", services };
  if (app && state(app.State) === "running" && state(app.Health) === "healthy") return { status: "ready", services };
  if (app && state(app.State) === "running") return { status: "starting", services };
  return { status: "stopped", services };
}

function parseComposePs(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }
}

function loadRuntime(parsed, io) {
  const runtime = runtimePaths(parsed, io);
  const state = readState(runtime.statePath);
  if (!state || !fs.existsSync(runtime.composePath) || !fs.existsSync(runtime.envPath)) {
    throw new Error("Local AnswerLayer is not initialized. Run `answerlayer local init` first.");
  }
  return { ...runtime, state };
}

function runtimePaths(parsed, io) {
  const directory = path.resolve(
    firstValue(parsed.flags.runtimeDir)
      || io.env.ANSWERLAYER_LOCAL_DIR
      || defaultRuntimeDirectory(io.env, io.platform || process.platform),
  );
  return {
    directory,
    composePath: path.join(directory, "compose.yaml"),
    envPath: path.join(directory, "runtime.env"),
    statePath: path.join(directory, "state.json"),
  };
}

function defaultRuntimeDirectory(env, platform) {
  const home = env.HOME || os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "AnswerLayer", "local");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "AnswerLayer", "local");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "answerlayer", "local");
}

function writeCompose(composePath) {
  fs.writeFileSync(composePath, `${COMPOSE_FILE}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(composePath, 0o600);
}

function writeEnvironment(envPath, state) {
  const existing = readEnvironment(envPath);
  const values = {
    ANSWERLAYER_IMAGE: state.resolvedImage,
    ANSWERLAYER_POSTGRES_PASSWORD: existing.ANSWERLAYER_POSTGRES_PASSWORD || crypto.randomBytes(24).toString("hex"),
    ANSWERLAYER_ENCRYPTION_KEY: existing.ANSWERLAYER_ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex"),
    ANSWERLAYER_PORT: String(state.port),
    ANSWERLAYER_LOG_LEVEL: existing.ANSWERLAYER_LOG_LEVEL || "INFO",
    ANSWERLAYER_WEB_CONCURRENCY: existing.ANSWERLAYER_WEB_CONCURRENCY || "1",
    ANSWERLAYER_ANTHROPIC_API_KEY: existing.ANSWERLAYER_ANTHROPIC_API_KEY || "",
    ANSWERLAYER_POSTGRES_VOLUME: existing.ANSWERLAYER_POSTGRES_VOLUME || "answerlayer-local-postgres-data",
    ANSWERLAYER_NETWORK: existing.ANSWERLAYER_NETWORK || "answerlayer-local-network",
  };
  const contents = Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n");
  fs.writeFileSync(envPath, `${contents}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

function readEnvironment(envPath) {
  if (!fs.existsSync(envPath)) return {};
  return Object.fromEntries(
    fs.readFileSync(envPath, "utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid local runtime state at ${statePath}: ${error.message}`);
  }
}

function writeState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(statePath, 0o600);
}

function composeArgs(runtime) {
  return [
    "compose", "--project-name", PROJECT_NAME,
    "--file", runtime.composePath,
    "--env-file", runtime.envPath,
  ];
}

function parseBootstrapApiKey(stdout) {
  const initLine = String(stdout).split(/\r?\n/).find(line => /(?:^|\s)answerlayer\s+init(?:\s|$)/.test(line));
  const match = initLine?.match(/(?:^|\s)--api-key(?:=|\s+)(\S+)/);
  if (!match) throw new Error("Local bootstrap completed without returning CLI credentials");
  return match[1];
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Expected --port to be an integer from 1 to 65535; received ${value}`);
  }
  return port;
}

function freeBytes(directory) {
  const stats = fs.statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function portIsAvailable(port, io) {
  if (io.portIsAvailable) return Promise.resolve(io.portIsAvailable(port));
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

function requireCommand(run, command, args) {
  const result = run(command, args, { capture: true });
  if (result.error?.code === "ENOENT" || result.status !== 0) {
    throw new Error(`${command} is required for local setup and must be running`);
  }
}

function checked(run, command, args, options = {}) {
  const result = run(command, args, { capture: !options.passthrough });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return { ...result, stdout: String(result.stdout || "") };
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function printRuntimeSummary(runtime, io, heading) {
  write(io.stdout, `${heading}\n`);
  write(io.stdout, `URL: http://127.0.0.1:${runtime.state.port}\n`);
  write(io.stdout, `Image: ${runtime.state.requestedImage}\n`);
  write(io.stdout, `Resolved image: ${runtime.state.resolvedImage}\n`);
  write(io.stdout, `Runtime config: ${runtime.directory}\n`);
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function write(stream, text) {
  stream.write(text);
}

const COMPOSE_FILE = [
  "name: answerlayer-local",
  "",
  "x-answerlayer-database-environment: &answerlayer-database-environment",
  "  DB_HOST: postgres",
  "  DB_PORT: \"5432\"",
  "  DB_USER: answerlayer",
  "  DB_PASSWORD: ${ANSWERLAYER_POSTGRES_PASSWORD:?Set ANSWERLAYER_POSTGRES_PASSWORD}",
  "  DB_NAME: answerlayer",
  "",
  "services:",
  "  postgres:",
  "    image: postgres:14",
  "    environment:",
  "      POSTGRES_USER: answerlayer",
  "      POSTGRES_PASSWORD: ${ANSWERLAYER_POSTGRES_PASSWORD:?Set ANSWERLAYER_POSTGRES_PASSWORD}",
  "      POSTGRES_DB: answerlayer",
  "    volumes:",
  "      - postgres-data:/var/lib/postgresql/data",
  "    healthcheck:",
  "      test: [\"CMD-SHELL\", \"pg_isready -U answerlayer -d answerlayer\"]",
  "      interval: 5s",
  "      timeout: 5s",
  "      retries: 12",
  "    restart: unless-stopped",
  "    networks: [internal]",
  "",
  "  migrate:",
  "    image: ${ANSWERLAYER_IMAGE:?Set ANSWERLAYER_IMAGE}",
  "    command: [\"alembic\", \"upgrade\", \"head\"]",
  "    environment:",
  "      <<: *answerlayer-database-environment",
  "    depends_on:",
  "      postgres:",
  "        condition: service_healthy",
  "    restart: \"no\"",
  "    networks: [internal]",
  "",
  "  answerlayer:",
  "    image: ${ANSWERLAYER_IMAGE:?Set ANSWERLAYER_IMAGE}",
  "    environment:",
  "      <<: *answerlayer-database-environment",
  "      ENVIRONMENT: development",
  "      LOG_LEVEL: ${ANSWERLAYER_LOG_LEVEL:-INFO}",
  "      WEB_CONCURRENCY: ${ANSWERLAYER_WEB_CONCURRENCY:-1}",
  "      ENCRYPTION_KEY: ${ANSWERLAYER_ENCRYPTION_KEY:?Set ANSWERLAYER_ENCRYPTION_KEY}",
  "      ANTHROPIC_API_KEY: ${ANSWERLAYER_ANTHROPIC_API_KEY:-}",
  "      ALLOW_INTERNAL_AUTH: \"true\"",
  "      LOCAL_BOOTSTRAP_ENABLED: \"true\"",
  "      DEBUG_ENDPOINTS_ENABLED: \"false\"",
  "      EVAL_WORKER_ENABLED: \"false\"",
  "      RESULT_GC_INTERVAL_SECONDS: \"0\"",
  "      TELEMETRY_PUSH_INTERVAL_SECONDS: \"0\"",
  "      METER_SYNC_INTERVAL_SECONDS: \"0\"",
  "      FRONTEND_BASE_URL: http://127.0.0.1:${ANSWERLAYER_PORT:-8000}",
  "      CORS_ORIGINS: http://127.0.0.1:${ANSWERLAYER_PORT:-8000},http://localhost:${ANSWERLAYER_PORT:-8000}",
  "    ports:",
  "      - \"127.0.0.1:${ANSWERLAYER_PORT:-8000}:8000\"",
  "    depends_on:",
  "      postgres:",
  "        condition: service_healthy",
  "      migrate:",
  "        condition: service_completed_successfully",
  "    healthcheck:",
  "      test: [\"CMD\", \"curl\", \"--fail\", \"http://localhost:8000/readyz\"]",
  "      interval: 5s",
  "      timeout: 5s",
  "      start_period: 10s",
  "      retries: 12",
  "    restart: unless-stopped",
  "    networks: [internal]",
  "",
  "volumes:",
  "  postgres-data:",
  "    name: ${ANSWERLAYER_POSTGRES_VOLUME:-answerlayer-local-postgres-data}",
  "",
  "networks:",
  "  internal:",
  "    name: ${ANSWERLAYER_NETWORK:-answerlayer-local-network}",
].join("\n");
