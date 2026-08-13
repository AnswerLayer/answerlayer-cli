import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { AnswerLayerClient } from "./client.js";
import { defaultConfigPath, readConfig, writeConfig } from "./config.js";

export const DEFAULT_LOCAL_IMAGE = "public.ecr.aws/s8d9x7y7/answerlayer:1.20.3";
const DEFAULT_PORT = 8000;
const MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const PROVIDER_VALIDATION_TIMEOUT_MS = 15_000;
const LOCAL_DEMO_VERSION = "retail-v1";
const LOCAL_DEMO_CONNECTION_NAME = "AnswerLayer Demo";
const LOCAL_DEMO_SAVED_QUERY_NAME = "Monthly revenue by region";
const LOCAL_DEMO_DATABASE = "answerlayer_demo";
const LOCAL_DEMO_USER = "answerlayer_demo_reader";
const LOCAL_DEMO_QUESTIONS = [
  "How much completed revenue did we generate each month?",
  "Which region generated the most completed revenue?",
  "How did completed revenue change from January to March?",
];
const LOCAL_QUICKSTART_QUESTION = LOCAL_DEMO_QUESTIONS[0];
const LOCAL_PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    environmentName: "ANSWERLAYER_ANTHROPIC_API_KEY",
  },
};
const CLI_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export async function handleLocal(command, parsed, io) {
  if (command === "init") return localInit(parsed, io);
  if (command === "start" || command === "up") return localStart(parsed, io);
  if (command === "status") return localStatus(parsed, io);
  if (command === "logs") return localLogs(parsed, io);
  if (command === "stop") return localStop(parsed, io);
  if (command === "demo") return localDemo(parsed, io);
  if (command === "provider") return localProvider(parsed, io);
  if (command === "quickstart") return localQuickstart(parsed, io);
  if (command === "upgrade") return localUpgrade(parsed, io);
  if (command === "reset") return localReset(parsed, io);
  throw new Error("Expected `answerlayer local init|start|status|logs|stop|demo|provider|quickstart|upgrade|reset`");
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
  const demo = parsed.flags.noDemo
    ? { status: "skipped", version: LOCAL_DEMO_VERSION }
    : await ensureLocalDemo(runtime, baseUrl, io);
  const state = { ...runtime.state, demo, lastStatus: "ready", updatedAt: new Date().toISOString() };
  writeState(runtime.statePath, state);

  printRuntimeSummary({ ...runtime, state }, io, "Local AnswerLayer is ready.");
  write(io.stdout, `CLI config: ${configPath}\n`);
  if (demo.status === "ready") {
    printDemoSummary(demo, io);
  } else {
    write(io.stdout, "Demo: skipped (--no-demo)\n");
    write(io.stdout, "Install it later with: answerlayer local demo\n");
  }
  return { runtime: { ...runtime, state }, baseUrl, configPath, demo };
}

async function localQuickstart(parsed, io) {
  if (!(await confirmQuickstart(parsed, io))) {
    throw new Error("Quickstart cancelled before making local runtime changes.");
  }

  const progressIo = { ...io, stdout: io.stderr };
  const started = await localStart({
    ...parsed,
    flags: { ...parsed.flags, noDemo: false },
  }, progressIo);
  const { runtime, baseUrl, demo } = started;
  const provider = resolveLocalProvider("anthropic");
  const configured = Boolean(readEnvironment(runtime.envPath)[provider.environmentName]);
  let providerStatus;

  if (!configured) {
    providerStatus = providerResult(provider, false, "ready", { verified: false, errorCode: "not-configured" });
    const result = quickstartResult(runtime, demo, providerStatus, {
      status: "not-run",
      question: LOCAL_QUICKSTART_QUESTION,
    });
    persistQuickstart(runtime, { status: "provider-required", question: LOCAL_QUICKSTART_QUESTION });
    printQuickstart(result, parsed, io);
    return result;
  }

  const verification = validateProvider(runtime, io.runCommand || runCommand, provider);
  providerStatus = providerResult(provider, true, "ready", verification);
  if (!verification.verified) {
    const result = quickstartResult(runtime, demo, providerStatus, {
      status: "not-run",
      question: LOCAL_QUICKSTART_QUESTION,
    });
    persistQuickstart(runtime, {
      status: "provider-verification-failed",
      question: LOCAL_QUICKSTART_QUESTION,
      errorCode: verification.errorCode,
    });
    printQuickstart(result, parsed, io);
    return result;
  }

  let inquiry = runtime.state.quickstart?.status === "complete"
    && runtime.state.quickstart.question === LOCAL_QUICKSTART_QUESTION
    && runtime.state.quickstart.connectionId === demo.connectionId
    ? runtime.state.quickstart.inquiry
    : null;
  if (!inquiry) {
    inquiry = await runQuickstartInquiry(baseUrl, demo.connectionId, io);
    persistQuickstart(runtime, {
      status: "complete",
      question: LOCAL_QUICKSTART_QUESTION,
      connectionId: demo.connectionId,
      inquiry,
      completedAt: new Date().toISOString(),
    });
  }

  const result = quickstartResult(runtime, demo, providerStatus, inquiry);
  printQuickstart(result, parsed, io);
  return result;
}

async function localDemo(parsed, io) {
  const run = io.runCommand || runCommand;
  const runtime = loadRuntime(parsed, io);
  requireCommand(run, "docker", ["compose", "version"]);
  const status = inspectStatus(runtime, run, { tolerateFailure: true });
  if (status.status !== "ready") {
    throw new Error("Local AnswerLayer must be ready before installing the demo. Run `answerlayer local start` first.");
  }

  const baseUrl = `http://127.0.0.1:${runtime.state.port}`;
  await ensureLocalCredentials(runtime, baseUrl, io, { quiet: Boolean(parsed.flags.json) });
  const demo = await ensureLocalDemo(runtime, baseUrl, io, { quiet: Boolean(parsed.flags.json) });
  writeState(runtime.statePath, {
    ...runtime.state,
    demo,
    lastStatus: "ready",
    updatedAt: new Date().toISOString(),
  });

  if (parsed.flags.json) {
    write(io.stdout, `${JSON.stringify(demo, null, 2)}\n`);
    return;
  }
  printDemoSummary(demo, io);
}

async function localProvider(parsed, io) {
  const action = parsed.positionals[2];
  if (!action || !["set", "rotate", "status", "verify", "remove"].includes(action)) {
    throw new Error("Expected `answerlayer local provider set|rotate|status|verify|remove`");
  }
  const provider = resolveLocalProvider(parsed.positionals[3]);
  if (action === "set" || action === "rotate") return localProviderSet(parsed, io, provider, action);
  if (action === "status" || action === "verify") return localProviderStatus(parsed, io, provider, action);
  return localProviderRemove(parsed, io, provider);
}

async function localProviderSet(parsed, io, provider, action) {
  if (parsed.flags.apiKey) {
    throw new Error("Provider secrets are not accepted in command arguments. Use the hidden prompt or --from-file <path>.");
  }
  const run = io.runCommand || runCommand;
  const runtime = requireReadyRuntime(parsed, io, run);
  const environment = readEnvironment(runtime.envPath);
  const existingSecret = environment[provider.environmentName] || "";
  if (action === "rotate" && !existingSecret) {
    throw new Error(`${provider.label} is not configured. Use \`answerlayer local provider set ${provider.id}\` first.`);
  }
  const secret = await readProviderSecret(parsed, io, provider);

  writeEnvironmentValue(runtime.envPath, provider.environmentName, secret);
  try {
    restartProviderRuntime(runtime, run);
  } catch {
    rollbackProviderCredential(runtime, run, provider, existingSecret, "updating");
    throw new Error(`Could not restart AnswerLayer with the new ${provider.label} credential. The previous configuration was restored.`);
  }

  const verification = validateProvider(runtime, run, provider);
  if (!verification.verified) {
    rollbackProviderCredential(runtime, run, provider, existingSecret, "verifying");
    throw new Error(`${provider.label} verification failed (${verification.errorCode}). The previous configuration was restored.`);
  }

  const result = providerResult(provider, true, "ready", verification);
  if (parsed.flags.json) {
    write(io.stdout, `${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  write(io.stdout, `${provider.label} credential ${action === "rotate" || existingSecret ? "rotated" : "configured"} and verified.\n`);
  write(io.stdout, "The AnswerLayer application was recreated; local database data was preserved.\n");
}

async function localProviderStatus(parsed, io, provider, action) {
  const run = io.runCommand || runCommand;
  const runtime = loadRuntime(parsed, io);
  requireCommand(run, "docker", ["compose", "version"]);
  const runtimeStatus = inspectStatus(runtime, run, { tolerateFailure: true }).status;
  const configured = Boolean(readEnvironment(runtime.envPath)[provider.environmentName]);
  const verification = configured && runtimeStatus === "ready"
    ? validateProvider(runtime, run, provider)
    : { verified: false, errorCode: configured ? "runtime-not-ready" : "not-configured" };
  const result = providerResult(provider, configured, runtimeStatus, verification);

  if (action === "verify" && result.status !== "verified") {
    throw new Error(`${provider.label} is ${result.status}. Run \`answerlayer local provider set ${provider.id}\` to configure and verify it.`);
  }
  if (parsed.flags.json) {
    write(io.stdout, `${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  write(io.stdout, `Provider: ${provider.id}\n`);
  write(io.stdout, `Status: ${result.status}\n`);
  write(io.stdout, `Runtime: ${runtimeStatus}\n`);
  if (result.errorCode && result.status === "verification-failed") {
    write(io.stdout, `Verification error: ${result.errorCode}\n`);
  }
}

async function localProviderRemove(parsed, io, provider) {
  if (!parsed.flags.force) {
    throw new Error(`Removing ${provider.label} disables model-backed features. Rerun with \`answerlayer local provider remove ${provider.id} --force\` to confirm.`);
  }
  const run = io.runCommand || runCommand;
  const runtime = requireReadyRuntime(parsed, io, run);
  const existingSecret = readEnvironment(runtime.envPath)[provider.environmentName] || "";
  writeEnvironmentValue(runtime.envPath, provider.environmentName, "");
  try {
    restartProviderRuntime(runtime, run);
  } catch {
    rollbackProviderCredential(runtime, run, provider, existingSecret, "removing");
    throw new Error(`Could not remove ${provider.label}. The previous configuration was restored.`);
  }
  const result = providerResult(provider, false, "ready", { verified: false, errorCode: "not-configured" });
  if (parsed.flags.json) {
    write(io.stdout, `${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  write(io.stdout, `${provider.label} credential removed. Model-backed features are disabled.\n`);
  write(io.stdout, "The AnswerLayer application was recreated; local database data was preserved.\n");
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
    demo: runtime.state.demo || { status: "not-installed", version: LOCAL_DEMO_VERSION },
    quickstart: runtime.state.quickstart || { status: "not-started", question: LOCAL_QUICKSTART_QUESTION },
    providers: localProviderConfiguration(runtime),
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
  write(io.stdout, `Demo: ${result.demo.status} (${result.demo.version})\n`);
  write(io.stdout, `Quickstart: ${result.quickstart.status}\n`);
  write(io.stdout, `Model provider: ${result.providers.anthropic.configured ? "anthropic (configured)" : "not configured"}\n`);
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
  writeState(runtime.statePath, {
    ...runtime.state,
    demo: { status: "not-installed", version: LOCAL_DEMO_VERSION },
    quickstart: { status: "not-started", question: LOCAL_QUICKSTART_QUESTION },
    lastStatus: "stopped",
    resetAt: new Date().toISOString(),
  });
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
    ...(existingState?.demo ? { demo: existingState.demo } : {}),
    ...(existingState?.quickstart ? { quickstart: existingState.quickstart } : {}),
    ...runtimeResourceNames(runtime.directory),
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

async function ensureLocalCredentials(runtime, baseUrl, io, options = {}) {
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

  if (!options.quiet) {
    write(io.stdout, "Creating a local-only CLI identity...\n");
  }
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
    ANSWERLAYER_DEMO_PASSWORD: existing.ANSWERLAYER_DEMO_PASSWORD || crypto.randomBytes(24).toString("hex"),
    ANSWERLAYER_PORT: String(state.port),
    ANSWERLAYER_LOG_LEVEL: existing.ANSWERLAYER_LOG_LEVEL || "INFO",
    ANSWERLAYER_WEB_CONCURRENCY: existing.ANSWERLAYER_WEB_CONCURRENCY || "1",
    ANSWERLAYER_ANTHROPIC_API_KEY: existing.ANSWERLAYER_ANTHROPIC_API_KEY || "",
    ANSWERLAYER_POSTGRES_VOLUME: state.postgresVolume,
    ANSWERLAYER_NETWORK: state.networkName,
  };
  const contents = Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n");
  fs.writeFileSync(envPath, `${contents}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

function writeEnvironmentValue(envPath, name, value) {
  const values = readEnvironment(envPath);
  values[name] = value;
  const contents = Object.entries(values).map(([entryName, entryValue]) => `${entryName}=${entryValue}`).join("\n");
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

function localProviderConfiguration(runtime) {
  const environment = readEnvironment(runtime.envPath);
  return Object.fromEntries(Object.entries(LOCAL_PROVIDERS).map(([id, provider]) => [
    id,
    { configured: Boolean(environment[provider.environmentName]) },
  ]));
}

function resolveLocalProvider(value) {
  const id = String(value || "anthropic").toLowerCase();
  const provider = LOCAL_PROVIDERS[id];
  if (!provider) {
    throw new Error(`Unsupported local model provider ${value}. Supported providers: ${Object.keys(LOCAL_PROVIDERS).join(", ")}`);
  }
  return { id, ...provider };
}

function requireReadyRuntime(parsed, io, run) {
  const runtime = loadRuntime(parsed, io);
  requireCommand(run, "docker", ["compose", "version"]);
  const status = inspectStatus(runtime, run, { tolerateFailure: true });
  if (status.status !== "ready") {
    throw new Error("Local AnswerLayer must be ready before changing a model provider. Run `answerlayer local start` first.");
  }
  return runtime;
}

async function readProviderSecret(parsed, io, provider) {
  const filePath = firstValue(parsed.flags.fromFile) || io.env.ANSWERLAYER_PROVIDER_KEY_FILE;
  let secret;
  if (filePath) {
    const resolvedPath = path.resolve(filePath);
    let stats;
    try {
      stats = fs.statSync(resolvedPath);
    } catch {
      throw new Error(`Could not read the provider credential file at ${resolvedPath}`);
    }
    if (!stats.isFile()) throw new Error(`Provider credential path is not a file: ${resolvedPath}`);
    if ((io.platform || process.platform) !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error(`Provider credential file permissions are too broad. Run \`chmod 600 ${resolvedPath}\` and retry.`);
    }
    secret = fs.readFileSync(resolvedPath, "utf8").trim();
  } else if (io.readSecret) {
    secret = await io.readSecret(`${provider.label} API key: `);
  } else {
    secret = await readHiddenInput(io.stdin, io.stderr, `${provider.label} API key: `);
  }

  if (typeof secret !== "string" || secret.length < 12 || /\s/.test(secret)) {
    throw new Error(`${provider.label} credential is empty or invalid. Use a single-line API key.`);
  }
  return secret;
}

function readHiddenInput(input, output, prompt) {
  if (!input?.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("A terminal is required for hidden credential entry. Run this command in your own terminal or use --from-file <mode-0600-path>.");
  }
  write(output, prompt);
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : false;
    let secret = "";
    let settled = false;
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onClose);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      if (wasPaused && typeof input.pause === "function") input.pause();
      write(output, "\n");
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(secret);
    };
    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("Provider credential entry cancelled"));
        if (character === "\u007f" || character === "\b") {
          secret = secret.slice(0, -1);
        } else if (character >= " ") {
          secret += character;
        }
      }
    };
    const onEnd = () => finish(new Error("Provider credential input ended before submission"));
    const onClose = () => finish(new Error("Provider credential input closed before submission"));
    const onError = () => finish(new Error("Provider credential input failed before submission"));
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onClose);
    input.once("error", onError);
    if (typeof input.resume === "function") input.resume();
  });
}

function restartProviderRuntime(runtime, run) {
  const result = run("docker", [
    ...composeArgs(runtime),
    "up", "--detach", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "180", "answerlayer",
  ], { capture: true });
  if (result.error || result.status !== 0) {
    throw new Error("AnswerLayer application restart failed");
  }
}

function rollbackProviderCredential(runtime, run, provider, existingSecret, action) {
  writeEnvironmentValue(runtime.envPath, provider.environmentName, existingSecret);
  try {
    restartProviderRuntime(runtime, run);
  } catch {
    throw new Error(`Could not restart AnswerLayer while ${action} ${provider.label}. The previous credential remains in runtime.env; run \`answerlayer local start\` to recover.`);
  }
}

function validateProvider(runtime, run, provider) {
  const result = run("docker", [
    ...composeArgs(runtime),
    "exec", "-T", "answerlayer", "python", "-c", PROVIDER_VALIDATION_SCRIPT,
  ], { capture: true, timeout: PROVIDER_VALIDATION_TIMEOUT_MS });
  if (result.error?.code === "ETIMEDOUT") {
    return { verified: false, errorCode: `${provider.id}-verification-timeout` };
  }
  const payload = parseProviderValidation(result.stdout);
  if (!result.error && result.status === 0 && payload?.verified === true) {
    return { verified: true };
  }
  return {
    verified: false,
    errorCode: /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(payload?.error || "")
      ? payload.error
      : `${provider.id}-verification-failed`,
  };
}

function parseProviderValidation(stdout) {
  const line = String(stdout || "").trim().split(/\r?\n/).at(-1);
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function providerResult(provider, configured, runtimeStatus, verification) {
  const status = !configured
    ? "unconfigured"
    : runtimeStatus !== "ready"
      ? "configured-runtime-not-ready"
      : verification.verified
        ? "verified"
        : "verification-failed";
  return {
    provider: provider.id,
    configured,
    status,
    runtimeStatus,
    ...(status === "verification-failed" ? { errorCode: verification.errorCode } : {}),
  };
}

async function confirmQuickstart(parsed, io) {
  if (parsed.flags.yes) return true;
  const prompt = "Quickstart may pull an image, start local containers, and create persistent demo data. Continue? [y/N] ";
  if (io.confirm) return Boolean(await io.confirm(prompt));
  if (!io.stdin?.isTTY) {
    throw new Error("Quickstart requires confirmation before starting containers. Rerun interactively or use --yes only after the user approves.");
  }
  const terminal = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const answer = await terminal.question(prompt);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

async function runQuickstartInquiry(baseUrl, connectionId, io) {
  const config = readConfig(io.env);
  if (config.baseUrl !== baseUrl || !config.apiKey) {
    throw new Error("Local CLI credentials are unavailable. Run `answerlayer local start` and retry quickstart.");
  }
  const client = new AnswerLayerClient({
    baseUrl,
    apiKey: config.apiKey,
    fetchImpl: io.fetch || globalThis.fetch,
  });
  const catalog = await client.request("GET", "/api/v1/inquiry/models");
  const model = catalog?.default_model;
  if (!model) throw new Error("The local runtime did not return a default inquiry model.");
  const session = await client.request("POST", "/api/v1/inquiry/sessions", {
    body: { connection_id: connectionId, model, use_semantic_layer: true },
  });
  if (!session?.session_id) throw new Error("Quickstart inquiry did not return a session ID.");
  const turn = await client.request(
    "POST",
    `/api/v1/inquiry/sessions/${encodeURIComponent(session.session_id)}/sync`,
    { body: { user_input: LOCAL_QUICKSTART_QUESTION } },
  );
  if (!String(turn?.final_response || "").trim()) {
    throw new Error("Quickstart inquiry completed without a model response. Check `answerlayer local logs answerlayer` and retry.");
  }
  return {
    status: "verified",
    sessionId: String(session.session_id),
    turnId: turn.turn_id ? String(turn.turn_id) : null,
    model,
    question: LOCAL_QUICKSTART_QUESTION,
    answer: String(turn.final_response),
    sqlQueries: Array.isArray(turn.sql_queries) ? turn.sql_queries.map(String) : [],
  };
}

function persistQuickstart(runtime, quickstart) {
  const state = {
    ...runtime.state,
    quickstart,
    updatedAt: new Date().toISOString(),
  };
  writeState(runtime.statePath, state);
  runtime.state = state;
}

function quickstartResult(runtime, demo, provider, inquiry) {
  const status = provider.status === "unconfigured"
    ? "provider-required"
    : provider.status !== "verified"
      ? "provider-verification-failed"
      : inquiry.status === "verified"
        ? "complete"
        : "inquiry-not-run";
  return {
    schemaVersion: 1,
    status,
    cliVersion: CLI_VERSION,
    runtime: {
      status: "ready",
      url: `http://127.0.0.1:${runtime.state.port}`,
      image: runtime.state.requestedImage,
      resolvedImage: runtime.state.resolvedImage,
      directory: runtime.directory,
    },
    demo: {
      status: demo.status,
      version: demo.version,
      connectionId: demo.connectionId,
      savedQueryId: demo.savedQueryId,
      validation: demo.validation,
    },
    provider,
    inquiry,
    nextActions: status === "provider-required"
      ? ["answerlayer local provider set anthropic", "answerlayer local quickstart"]
      : status === "provider-verification-failed"
        ? ["answerlayer local provider set anthropic", "answerlayer local quickstart"]
        : LOCAL_DEMO_QUESTIONS.slice(1).map(question => `answerlayer inquiry ask --connection ${demo.connectionId} "${question}"`),
  };
}

function printQuickstart(result, parsed, io) {
  if (parsed.flags.json) {
    write(io.stdout, `${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  write(io.stdout, `AnswerLayer quickstart: ${result.status}\n`);
  write(io.stdout, `URL: ${result.runtime.url}\n`);
  write(io.stdout, `Demo: ${result.demo.status} (${result.demo.version})\n`);
  if (result.status === "provider-required") {
    write(io.stdout, "A model provider is required for natural-language inquiry.\n");
    write(io.stdout, "Enter the credential privately in your terminal: answerlayer local provider set anthropic\n");
    write(io.stdout, "Then resume with: answerlayer local quickstart\n");
    return;
  }
  if (result.status === "provider-verification-failed") {
    write(io.stdout, `Provider verification failed: ${result.provider.errorCode}\n`);
    write(io.stdout, "Repair it privately with: answerlayer local provider set anthropic\n");
    return;
  }
  write(io.stdout, `Model inquiry verified with ${result.inquiry.model}.\n`);
  write(io.stdout, `Question: ${result.inquiry.question}\n`);
  write(io.stdout, `Answer: ${result.inquiry.answer}\n`);
  write(io.stdout, `Session: ${result.inquiry.sessionId}\n`);
  write(io.stdout, `Next: ${result.nextActions[0]}\n`);
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
    "compose", "--project-name", runtime.state.projectName,
    "--file", runtime.composePath,
    "--env-file", runtime.envPath,
  ];
}

function runtimeResourceNames(directory) {
  const id = crypto.createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 12);
  return {
    runtimeId: id,
    projectName: `answerlayer-local-${id}`,
    postgresVolume: `answerlayer-local-${id}-postgres-data`,
    networkName: `answerlayer-local-${id}-network`,
  };
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
  const result = run(command, args, { capture: !options.passthrough, input: options.input });
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
    input: options.input,
    timeout: options.timeout,
    stdio: options.capture
      ? [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      : "inherit",
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

function printDemoSummary(demo, io) {
  write(io.stdout, `Demo: ready (${demo.version})\n`);
  write(io.stdout, `Demo connection: ${demo.connectionId}\n`);
  write(io.stdout, `Verified result: ${demo.validation.completedOrderCount} completed orders, $${demo.validation.totalRevenue} revenue\n`);
  write(io.stdout, `Try now: answerlayer saved-queries execute ${demo.savedQueryId} --format table\n`);
  write(io.stdout, `After configuring a model provider, ask: answerlayer inquiry ask --connection ${demo.connectionId} "${demo.questions[0]}"\n`);
}

async function ensureLocalDemo(runtime, baseUrl, io, options = {}) {
  const environment = readEnvironment(runtime.envPath);
  const demoPassword = environment.ANSWERLAYER_DEMO_PASSWORD;
  if (!demoPassword || !/^[a-f0-9]{48}$/.test(demoPassword)) {
    throw new Error("The local demo password is missing or invalid. Run `answerlayer local init` to repair runtime configuration.");
  }

  const run = io.runCommand || runCommand;
  if (!options.quiet) {
    write(io.stdout, `Preparing deterministic demo data (${LOCAL_DEMO_VERSION})...\n`);
  }
  checked(run, "docker", [
    ...composeArgs(runtime),
    "exec", "-T", "postgres", "psql",
    "--set", "ON_ERROR_STOP=1",
    "--username", "answerlayer",
    "--dbname", "postgres",
  ], { input: demoSeedSql(demoPassword) });

  const config = readConfig(io.env);
  if (config.baseUrl !== baseUrl || !config.apiKey) {
    throw new Error("Local CLI credentials are not configured. Run `answerlayer local start` first.");
  }
  const client = new AnswerLayerClient({ baseUrl, apiKey: config.apiKey, fetchImpl: io.fetch || globalThis.fetch });

  const connection = await ensureDemoConnection(client, demoPassword);
  const connectionId = String(connection.id);
  const entities = [
    await ensureSemanticResource(client, "entities", connectionId, "Orders", {
      name: "Orders",
      source_table: "demo.orders",
      identifier: "id",
      temporal_key: "order_date",
      description: "Completed and refunded retail orders in the AnswerLayer onboarding demo.",
    }),
    await ensureSemanticResource(client, "entities", connectionId, "Customers", {
      name: "Customers",
      source_table: "demo.customers",
      identifier: "id",
      description: "Synthetic customers grouped by region and business segment.",
    }),
  ];
  const relationship = await ensureSemanticResource(client, "relationships", connectionId, "Orders to Customers", {
    name: "Orders to Customers",
    description: "Each order belongs to one customer.",
    from_entity: "Orders",
    to_entity: "Customers",
    join_keys: { from: "customer_id", to: "id" },
    cardinality: "many_to_one",
  });
  const dimensions = [
    await ensureSemanticResource(client, "dimensions", connectionId, "Order date", {
      name: "Order date",
      entity: "Orders",
      expression: "order_date",
      description: "Calendar date on which the order was placed.",
    }),
    await ensureSemanticResource(client, "dimensions", connectionId, "Customer region", {
      name: "Customer region",
      entity: "Customers",
      expression: "region",
      description: "North, South, East, or West sales region.",
    }),
  ];
  const measure = await ensureSemanticResource(client, "measures", connectionId, "Revenue", {
    name: "Revenue",
    entity: "Orders",
    expression: "quantity * unit_price",
    aggregation: "sum",
    default_filters: [],
    description: "Gross order value before refunds; use order status to select completed revenue.",
  });
  const savedQuery = await ensureDemoSavedQuery(client, connectionId);
  const queryResult = await client.runQuery(connectionId, {
    query: DEMO_VALIDATION_SQL,
    row_limit: 1,
    timeout: 30,
  });
  const completedOrderCount = Number(queryResult?.rows?.[0]?.[0]);
  const totalRevenue = Number(queryResult?.rows?.[0]?.[1]);
  if (completedOrderCount !== 11 || totalRevenue !== 12200) {
    throw new Error(
      `Demo verification returned an unexpected result (${completedOrderCount} orders, ${totalRevenue} revenue). Run \`answerlayer local demo\` to retry.`,
    );
  }

  return {
    status: "ready",
    version: LOCAL_DEMO_VERSION,
    connectionId,
    savedQueryId: String(savedQuery.id),
    semantic: {
      entityIds: entities.map(item => String(item.id)),
      relationshipId: String(relationship.id),
      dimensionIds: dimensions.map(item => String(item.id)),
      measureId: String(measure.id),
    },
    validation: {
      completedOrderCount,
      totalRevenue: totalRevenue.toFixed(2),
    },
    questions: LOCAL_DEMO_QUESTIONS,
  };
}

async function ensureDemoConnection(client, demoPassword) {
  const connections = await client.listConnections();
  const existing = Array.isArray(connections)
    ? connections.find(item => item.name === LOCAL_DEMO_CONNECTION_NAME)
    : null;
  if (existing) {
    if (existing.db_type !== "postgresql") {
      throw new Error(`The reserved connection name "${LOCAL_DEMO_CONNECTION_NAME}" is already used by a non-PostgreSQL connection.`);
    }
    const config = existing.config || {};
    const ownsDemoDatabase = config.pg_host === "postgres"
      && Number(config.pg_port) === 5432
      && config.db_name === LOCAL_DEMO_DATABASE
      && config.pg_username === LOCAL_DEMO_USER;
    if (!ownsDemoDatabase) {
      throw new Error(
        `The reserved connection name "${LOCAL_DEMO_CONNECTION_NAME}" is already used by a different PostgreSQL database. Rename or remove that connection, then rerun \`answerlayer local demo\`.`,
      );
    }
    return existing;
  }

  return client.request("POST", "/api/v1/connections/", {
    body: {
      name: LOCAL_DEMO_CONNECTION_NAME,
      description: `Versioned synthetic retail data for local onboarding (${LOCAL_DEMO_VERSION}).`,
      db_type: "postgresql",
      config: {
        host: "postgres",
        port: 5432,
        database_name: LOCAL_DEMO_DATABASE,
        username: LOCAL_DEMO_USER,
        password: demoPassword,
      },
      auto_pii_detection: false,
    },
  });
}

async function ensureSemanticResource(client, resource, connectionId, name, payload) {
  const pathName = `/api/v1/semantic/${resource}`;
  const result = await client.request("GET", pathName, { query: { connection_id: connectionId } });
  const items = Array.isArray(result?.[resource]) ? result[resource] : [];
  const existing = items.find(item => item.name === name);
  if (existing) return existing;
  return client.request("POST", pathName, {
    query: { connection_id: connectionId },
    body: payload,
  });
}

async function ensureDemoSavedQuery(client, connectionId) {
  const result = await client.listSavedQueries();
  const items = Array.isArray(result?.saved_queries) ? result.saved_queries : [];
  const existing = items.find(item => item.name === LOCAL_DEMO_SAVED_QUERY_NAME && String(item.connection_id) === connectionId);
  if (existing) return existing;
  return client.createSavedQuery({
    name: LOCAL_DEMO_SAVED_QUERY_NAME,
    description: "Completed order revenue grouped by month and customer region.",
    visibility: "org",
    sql: DEMO_SAVED_QUERY_SQL,
    connection_id: connectionId,
  });
}

function demoSeedSql(password) {
  const passwordLiteral = `'${password.replaceAll("'", "''")}'`;
  return `\\set ON_ERROR_STOP on
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOCAL_DEMO_USER}') THEN
    CREATE ROLE ${LOCAL_DEMO_USER} LOGIN PASSWORD ${passwordLiteral};
  ELSE
    ALTER ROLE ${LOCAL_DEMO_USER} LOGIN PASSWORD ${passwordLiteral};
  END IF;
END
$role$;

SELECT 'CREATE DATABASE ${LOCAL_DEMO_DATABASE} OWNER answerlayer'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${LOCAL_DEMO_DATABASE}')\\gexec

REVOKE ALL ON DATABASE ${LOCAL_DEMO_DATABASE} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${LOCAL_DEMO_DATABASE} TO ${LOCAL_DEMO_USER};

\\connect ${LOCAL_DEMO_DATABASE}

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS demo AUTHORIZATION answerlayer;
REVOKE ALL ON SCHEMA demo FROM PUBLIC;

CREATE TABLE IF NOT EXISTS demo.bootstrap_versions (
  version text PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS demo.customers (
  id integer PRIMARY KEY,
  name text NOT NULL,
  region text NOT NULL,
  segment text NOT NULL,
  signup_date date NOT NULL
);

CREATE TABLE IF NOT EXISTS demo.orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES demo.customers(id),
  order_date date NOT NULL,
  product text NOT NULL,
  category text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  status text NOT NULL CHECK (status IN ('completed', 'refunded'))
);

DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM demo.bootstrap_versions WHERE version = '${LOCAL_DEMO_VERSION}') THEN
    DELETE FROM demo.orders;
    DELETE FROM demo.customers;
    INSERT INTO demo.customers (id, name, region, segment, signup_date) VALUES
      (1, 'Maple & Co', 'North', 'SMB', '2025-10-12'),
      (2, 'Harbour Goods', 'South', 'Mid-market', '2025-11-03'),
      (3, 'Summit Systems', 'East', 'Enterprise', '2025-11-18'),
      (4, 'Cedar Studio', 'West', 'SMB', '2025-12-01'),
      (5, 'Northstar Labs', 'North', 'Enterprise', '2025-12-09'),
      (6, 'Lakeside Market', 'South', 'SMB', '2025-12-21');
    INSERT INTO demo.orders (id, customer_id, order_date, product, category, quantity, unit_price, status) VALUES
      (1, 1, '2026-01-05', 'Analytics seats', 'Subscription', 10, 50.00, 'completed'),
      (2, 2, '2026-01-08', 'Data connectors', 'Platform', 2, 900.00, 'completed'),
      (3, 3, '2026-01-12', 'Analytics seats', 'Subscription', 25, 50.00, 'completed'),
      (4, 4, '2026-01-20', 'Onboarding', 'Services', 1, 750.00, 'completed'),
      (5, 1, '2026-02-02', 'Analytics seats', 'Subscription', 12, 50.00, 'completed'),
      (6, 5, '2026-02-10', 'Data connectors', 'Platform', 3, 900.00, 'completed'),
      (7, 6, '2026-02-14', 'Onboarding', 'Services', 1, 750.00, 'completed'),
      (8, 3, '2026-02-22', 'Data connectors', 'Platform', 1, 900.00, 'refunded'),
      (9, 2, '2026-03-03', 'Analytics seats', 'Subscription', 18, 50.00, 'completed'),
      (10, 4, '2026-03-08', 'Data connectors', 'Platform', 2, 900.00, 'completed'),
      (11, 5, '2026-03-15', 'Onboarding', 'Services', 1, 750.00, 'completed'),
      (12, 6, '2026-03-25', 'Analytics seats', 'Subscription', 8, 50.00, 'completed');
    INSERT INTO demo.bootstrap_versions (version) VALUES ('${LOCAL_DEMO_VERSION}');
  END IF;
END
$seed$;

GRANT USAGE ON SCHEMA demo TO ${LOCAL_DEMO_USER};
GRANT SELECT ON ALL TABLES IN SCHEMA demo TO ${LOCAL_DEMO_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA demo GRANT SELECT ON TABLES TO ${LOCAL_DEMO_USER};
`;
}

const DEMO_VALIDATION_SQL = `
SELECT
  count(*)::integer AS completed_order_count,
  round(sum(quantity * unit_price), 2) AS total_revenue
FROM demo.orders
WHERE status = 'completed'
`.trim();

const DEMO_SAVED_QUERY_SQL = `
SELECT
  date_trunc('month', o.order_date)::date AS month,
  c.region,
  round(sum(o.quantity * o.unit_price), 2) AS revenue
FROM demo.orders AS o
JOIN demo.customers AS c ON c.id = o.customer_id
WHERE o.status = 'completed'
GROUP BY 1, 2
ORDER BY 1, 2
`.trim();

const PROVIDER_VALIDATION_SCRIPT = `
import json
import os

from anthropic import Anthropic

try:
    Anthropic(
        api_key=os.environ["ANTHROPIC_API_KEY"],
        max_retries=0,
        timeout=10.0,
    ).models.list(limit=1)
except Exception as error:
    print(json.dumps({"verified": False, "error": type(error).__name__}))
    raise SystemExit(1)

print(json.dumps({"verified": True}))
`.trim();

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
