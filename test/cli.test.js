import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { main } from "../src/cli.js";

test("configure writes base URL and API key to the configured path", async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-")), "config.json");
  const output = captureStream();

  await main([
    "configure",
    "--base-url",
    "https://answerlayer.example",
    "--api-key",
    "al_live_test",
  ], {
    env: { ANSWERLAYER_CONFIG: configPath },
    stdin: readableStdin(),
    stdout: output,
    stderr: captureStream(),
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
    baseUrl: "https://answerlayer.example",
    apiKey: "al_live_test",
  });
  assert.match(output.text(), /Saved AnswerLayer config/);
});

test("skills install copies the bundled AnswerLayer skill without credentials", async () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-skill-")), "answerlayer");
  const output = captureStream();

  await main(["skills", "install", "--path", target], {
    env: {},
    stdin: readableStdin(),
    stdout: output,
    stderr: captureStream(),
  });

  assert.ok(fs.existsSync(path.join(target, "SKILL.md")));
  assert.match(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), /Local stack workflow/);
  assert.match(output.text(), /Installed AnswerLayer skill/);
});

test("skills install requires --force to replace an existing skill", async () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-skill-")), "answerlayer");
  fs.mkdirSync(target);

  await assert.rejects(
    main(["skills", "install", "--path", target], {
      env: {},
      stdin: readableStdin(),
      stdout: captureStream(),
      stderr: captureStream(),
    }),
    /rerun with --force/,
  );
});

test("init verifies an API key before saving the configuration", async () => {
  const originalFetch = globalThis.fetch;
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-init-")), "config.json");
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/auth/me");
    assert.equal(init.method, "GET");
    assert.equal(init.headers["X-API-Key"], "al_live_test");
    return new Response(JSON.stringify({ email: "user@example.com" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "init",
      "--base-url",
      "https://answerlayer.example",
      "--api-key",
      "al_live_test",
    ], {
      env: { ANSWERLAYER_CONFIG: configPath },
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
    baseUrl: "https://answerlayer.example",
    apiKey: "al_live_test",
  });
  assert.match(output.text(), /Verified API key/);
  assert.match(output.text(), /answerlayer connections list/);
});

test("init leaves an existing configuration untouched when key verification fails", async () => {
  const originalFetch = globalThis.fetch;
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-init-")), "config.json");
  const originalConfig = { baseUrl: "https://working.example", apiKey: "al_live_working" };
  fs.writeFileSync(configPath, `${JSON.stringify(originalConfig)}\n`);

  globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Invalid API key" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

  try {
    await assert.rejects(
      main(["init", "--api-key", "al_live_bad"], {
        env: { ANSWERLAYER_CONFIG: configPath },
        stdin: readableStdin(),
        stdout: captureStream(),
        stderr: captureStream(),
      }),
      /Invalid API key/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), originalConfig);
});

test("init requires an explicit API key instead of reusing saved credentials", async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-init-")), "config.json");
  const originalConfig = { baseUrl: "https://working.example", apiKey: "al_live_working" };
  fs.writeFileSync(configPath, `${JSON.stringify(originalConfig)}\n`);

  await assert.rejects(
    main(["init"], {
      env: { ANSWERLAYER_CONFIG: configPath },
      stdin: readableStdin(),
      stdout: captureStream(),
      stderr: captureStream(),
    }),
    /requires an explicit --api-key/,
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), originalConfig);
});

test("local init pulls the public image and pins its digest without Git or provider credentials", async () => {
  const fixture = localFixture();

  await main(["local", "init"], fixture.io);

  const state = JSON.parse(fs.readFileSync(path.join(fixture.runtimeDir, "state.json"), "utf8"));
  assert.equal(state.requestedImage, "public.ecr.aws/s8d9x7y7/answerlayer:1.19.9");
  assert.equal(state.resolvedImage, fixture.resolvedImage);
  assert.equal(fs.statSync(path.join(fixture.runtimeDir, "runtime.env")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(fixture.runtimeDir, "runtime.env"), "utf8"), new RegExp(`ANSWERLAYER_IMAGE=${fixture.resolvedImage}`));
  assert.match(fs.readFileSync(path.join(fixture.runtimeDir, "compose.yaml"), "utf8"), /service_completed_successfully/);
  assert.equal(fixture.commands.some(([command]) => command === "git" || command === "make"), false);
  assert.match(fixture.output.text(), /Local AnswerLayer is initialized/);
});

test("local start reuses initialized state, starts the image stack, and configures local credentials", async () => {
  const fixture = localFixture();
  await main(["local", "init"], fixture.io);
  fixture.commands.length = 0;

  await main(["local", "start"], fixture.io);

  assert.equal(fixture.commands.some(([, args]) => args[0] === "pull"), false);
  assert.equal(fixture.commands.some(([, args]) => args.includes("up") && args.includes("--wait")), true);
  assert.equal(fixture.commands.some(([, args]) => args.includes("app.scripts.bootstrap_local")), true);
  const seedCommand = fixture.commands.find(([, args]) => args.includes("psql"));
  assert.ok(seedCommand);
  assert.match(seedCommand[2].input, /CREATE DATABASE answerlayer_demo/);
  assert.match(seedCommand[2].input, /GRANT SELECT ON ALL TABLES IN SCHEMA demo/);
  const runtimeEnvironment = fs.readFileSync(path.join(fixture.runtimeDir, "runtime.env"), "utf8");
  const demoPassword = runtimeEnvironment.match(/ANSWERLAYER_DEMO_PASSWORD=(.+)/)[1];
  assert.equal(seedCommand[1].join(" ").includes(demoPassword), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.configPath, "utf8")), {
    baseUrl: "http://127.0.0.1:8000",
    apiKey: "al_local_secret",
  });
  assert.doesNotMatch(fixture.output.text(), /al_local_secret/);
  assert.doesNotMatch(fixture.output.text(), new RegExp(demoPassword));
  assert.doesNotMatch(fs.readFileSync(path.join(fixture.runtimeDir, "state.json"), "utf8"), new RegExp(demoPassword));
  assert.match(fixture.output.text(), /Local AnswerLayer is ready/);
  assert.match(fixture.output.text(), /Demo: ready \(retail-v1\)/);
  assert.match(fixture.output.text(), /11 completed orders, \$12200\.00 revenue/);
  assert.match(fixture.output.text(), /saved-queries execute demo-saved-query-id/);
});

test("local demo bootstrap is API-backed and idempotent", async () => {
  const fixture = localFixture();
  await main(["local", "start"], fixture.io);
  const createCounts = countDemoCreateRequests(fixture.apiRequests);

  fixture.psOutput = JSON.stringify({ Service: "answerlayer", State: "running", Health: "healthy", ExitCode: 0 });
  fixture.output.clear();
  await main(["local", "demo", "--json"], fixture.io);

  const result = JSON.parse(fixture.output.text());
  assert.equal(result.status, "ready");
  assert.equal(result.version, "retail-v1");
  assert.equal(result.validation.completedOrderCount, 11);
  assert.equal(result.validation.totalRevenue, "12200.00");
  assert.deepEqual(countDemoCreateRequests(fixture.apiRequests), createCounts);
});

test("local demo JSON stays machine-readable when credentials must be recreated", async () => {
  const fixture = localFixture();
  await main(["local", "start"], fixture.io);
  fs.writeFileSync(fixture.configPath, "{}\n");

  fixture.psOutput = JSON.stringify({ Service: "answerlayer", State: "running", Health: "healthy", ExitCode: 0 });
  fixture.output.clear();
  await main(["local", "demo", "--json"], fixture.io);

  const result = JSON.parse(fixture.output.text());
  assert.equal(result.status, "ready");
  assert.equal(fixture.commands.filter(([, args]) => args.includes("app.scripts.bootstrap_local")).length, 2);
});

test("local demo seed failures do not persist a ready demo state", async () => {
  const fixture = localFixture({ seedError: "permission denied for database answerlayer_demo" });

  await assert.rejects(
    main(["local", "start"], fixture.io),
    /permission denied for database answerlayer_demo/,
  );

  const state = JSON.parse(fs.readFileSync(path.join(fixture.runtimeDir, "state.json"), "utf8"));
  assert.equal(state.demo, undefined);
  assert.notEqual(state.lastStatus, "ready");
});

test("local reinitialization and failed restarts preserve installed demo state", async () => {
  const fixture = localFixture();
  await main(["local", "start"], fixture.io);
  const installed = JSON.parse(fs.readFileSync(path.join(fixture.runtimeDir, "state.json"), "utf8")).demo;
  fixture.psOutput = JSON.stringify({ Service: "answerlayer", State: "running", Health: "healthy", ExitCode: 0 });
  fixture.seedError = "temporary demo seed failure";

  await assert.rejects(main(["local", "start"], fixture.io), /temporary demo seed failure/);

  const state = JSON.parse(fs.readFileSync(path.join(fixture.runtimeDir, "state.json"), "utf8"));
  assert.deepEqual(state.demo, installed);
});

test("local demo rejects a same-named connection to a different database", async () => {
  const fixture = localFixture();
  fixture.demoApi.connections.push({
    id: "colliding-connection-id",
    name: "AnswerLayer Demo",
    db_type: "postgresql",
    config: {
      pg_host: "production.example",
      pg_port: 5432,
      db_name: "production",
      pg_username: "production_reader",
    },
  });

  await assert.rejects(
    main(["local", "start"], fixture.io),
    /already used by a different PostgreSQL database/,
  );
  assert.equal(fixture.apiRequests.some(request => request.pathname.startsWith("/api/v1/semantic/")), false);
});

test("local start can explicitly skip demo installation", async () => {
  const fixture = localFixture();
  await main(["local", "start", "--no-demo"], fixture.io);

  assert.equal(fixture.commands.some(([, args]) => args.includes("psql")), false);
  assert.equal(fixture.apiRequests.some(request => request.pathname === "/api/v1/connections/"), false);
  assert.match(fixture.output.text(), /Demo: skipped/);
  const state = JSON.parse(fs.readFileSync(path.join(fixture.runtimeDir, "state.json"), "utf8"));
  assert.equal(state.demo.status, "skipped");
});

test("local up is an image-based spelling of local start", async () => {
  const fixture = localFixture();
  await main(["local", "up"], fixture.io);
  assert.equal(fixture.commands.some(([command]) => command === "git"), false);
  assert.equal(fixture.commands.some(([, args]) => args[0] === "pull"), true);
  assert.equal(fixture.commands.some(([, args]) => args.includes("up") && args.includes("--wait")), true);
});

test("local status distinguishes migration and exposes the pinned image", async () => {
  const fixture = localFixture();
  await main(["local", "init"], fixture.io);
  fixture.psOutput = JSON.stringify({ Service: "migrate", State: "running", Health: "", ExitCode: 0 });
  fixture.output.clear();

  await main(["local", "status", "--json"], fixture.io);

  const status = JSON.parse(fixture.output.text());
  assert.equal(status.status, "migrating");
  assert.equal(status.resolvedImage, fixture.resolvedImage);
});

test("local status shows demo installation state to humans", async () => {
  const fixture = localFixture();
  await main(["local", "start"], fixture.io);
  fixture.psOutput = JSON.stringify({ Service: "answerlayer", State: "running", Health: "healthy", ExitCode: 0 });
  fixture.output.clear();

  await main(["local", "status"], fixture.io);

  assert.match(fixture.output.text(), /Demo: ready \(retail-v1\)/);
});

test("local start reports an occupied port before starting containers", async () => {
  const fixture = localFixture({ portIsAvailable: false });
  await main(["local", "init"], fixture.io);

  await assert.rejects(main(["local", "start"], fixture.io), /Port 8000 is already in use/);
  assert.equal(fixture.commands.some(([, args]) => args.includes("up") && args.includes("--wait")), false);
});

test("local reset requires explicit confirmation and deletes only after --force", async () => {
  const fixture = localFixture();
  await main(["local", "init"], fixture.io);

  await assert.rejects(main(["local", "reset"], fixture.io), /reset --force/);
  await main(["local", "reset", "--force"], fixture.io);

  assert.equal(fixture.commands.some(([, args]) => args.includes("down") && args.includes("--volumes")), true);
  assert.match(fixture.output.text(), /Deleted the local AnswerLayer database volume/);
});

test("separate runtime directories use isolated Compose and persistent resource names", async () => {
  const first = localFixture();
  const second = localFixture();
  await main(["local", "init"], first.io);
  await main(["local", "init"], second.io);

  const firstState = JSON.parse(fs.readFileSync(path.join(first.runtimeDir, "state.json"), "utf8"));
  const secondState = JSON.parse(fs.readFileSync(path.join(second.runtimeDir, "state.json"), "utf8"));
  assert.notEqual(firstState.runtimeId, secondState.runtimeId);
  assert.notEqual(firstState.projectName, secondState.projectName);
  assert.notEqual(firstState.postgresVolume, secondState.postgresVolume);
  assert.notEqual(firstState.networkName, secondState.networkName);

  const firstEnvironment = fs.readFileSync(path.join(first.runtimeDir, "runtime.env"), "utf8");
  const secondEnvironment = fs.readFileSync(path.join(second.runtimeDir, "runtime.env"), "utf8");
  assert.match(firstEnvironment, new RegExp(`ANSWERLAYER_POSTGRES_VOLUME=${firstState.postgresVolume}`));
  assert.match(secondEnvironment, new RegExp(`ANSWERLAYER_POSTGRES_VOLUME=${secondState.postgresVolume}`));

  first.commands.length = 0;
  await main(["local", "reset", "--force"], first.io);
  const resetCommand = first.commands.find(([, args]) => args.includes("--volumes"));
  assert.ok(resetCommand);
  assert.equal(resetCommand[1].includes(firstState.projectName), true);
  assert.equal(resetCommand[1].includes(secondState.projectName), false);
});

test("local init rejects unsupported Docker versions and low disk space", async () => {
  const oldDocker = localFixture({ dockerVersion: "19.03.15" });
  await assert.rejects(main(["local", "init"], oldDocker.io), /Docker Engine 20.10 or newer/);

  const lowDisk = localFixture({ availableBytes: 1024 });
  await assert.rejects(main(["local", "init"], lowDisk.io), /at least 2 GB/);
});

test("defaults the base URL to the hosted SaaS when none is configured", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-empty-config-")), "config.json");

  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://app.answerlayer.io/api/v1/auth/me");
    return new Response(JSON.stringify({ email: "user@example.com" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main(["auth", "me", "--api-key", "al_live_test"], {
      env: { ANSWERLAYER_CONFIG: configPath },
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { email: "user@example.com" });
});

test("query run calls the AnswerLayer API with X-API-Key", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/query/connection-1");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-API-Key"], "al_live_test");
    assert.deepEqual(JSON.parse(init.body), {
      query: "select 1",
      params: null,
      row_limit: 1000,
      timeout: 30,
    });

    return new Response(JSON.stringify({
      columns: ["value"],
      rows: [[1]],
      row_count: 1,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "query",
      "run",
      "connection-1",
      "--base-url",
      "https://answerlayer.example",
      "--api-key",
      "al_live_test",
      "--sql",
      "select 1",
      "--json",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), {
    columns: ["value"],
    rows: [[1]],
    row_count: 1,
  });
});

test("semantic entities create maps flags to the semantic API", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/semantic/entities?connection_id=conn-1");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-API-Key"], "al_live_test");
    assert.deepEqual(JSON.parse(init.body), {
      name: "orders",
      description: "Customer orders",
      source_table: "public.orders",
      identifier: "id",
    });

    return new Response(JSON.stringify({ id: "entity-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "semantic",
      "entities",
      "create",
      "--base-url",
      "https://answerlayer.example",
      "--api-key",
      "al_live_test",
      "--connection",
      "conn-1",
      "--name",
      "orders",
      "--description",
      "Customer orders",
      "--source-table",
      "public.orders",
      "--identifier",
      "id",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { id: "entity-1" });
});

test("documents upload builds multipart request ergonomically", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-upload-"));
  const uploadPath = path.join(tempDir, "sample.md");
  fs.writeFileSync(uploadPath, "# Context\n");

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/context-documents/upload");
    assert.equal(init.method, "POST");
    assert.ok(init.body instanceof FormData);
    assert.equal(init.headers["Content-Type"], undefined);
    assert.equal(init.body.get("title"), "Product context");
    assert.equal(init.body.get("description"), "Shared business definitions");
    assert.equal(init.body.get("file").name, "sample.md");

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "documents",
      "upload",
      uploadPath,
      "--base-url",
      "https://answerlayer.example",
      "--api-key",
      "al_live_test",
      "--title",
      "Product context",
      "--description",
      "Shared business definitions",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { ok: true });
});

test("inquiry models lists the deployment's available model catalog", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/inquiry/models");
    assert.equal(init.method, "GET");
    return new Response(JSON.stringify({
      default_model: "openai.gpt-5.6-terra",
      models: [{
        id: "openai.gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        description: "Balanced production performance and cost",
        family: "OpenAI",
        transport: "responses",
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "inquiry", "models",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(output.text(), /Default model: openai\.gpt-5\.6-terra/);
  assert.match(output.text(), /GPT-5\.6 Terra/);
});

test("evals suites create maps common flags to the evaluation API", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/suites");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      name: "Revenue checks",
      connection_id: "connection-1",
      description: "Critical revenue questions",
    });
    return new Response(JSON.stringify({ id: "suite-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "suites", "create",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--name", "Revenue checks",
      "--connection", "connection-1",
      "--description", "Critical revenue questions",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { id: "suite-1" });
});

test("evals cases create accepts evaluator flags and repeated constraints", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/suites/suite-1/cases");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      title: "Monthly revenue",
      question: "What was revenue last month?",
      category: "Revenue",
      expected_sql: "select sum(amount) from orders",
      expected_values: [1200, "USD"],
      required_tools: ["query_database", "format_answer"],
      forbidden_tools: ["web_search"],
      tags: ["revenue", "critical"],
      evaluator_config: { answer_similarity_weight: 0.5 },
      numeric_tolerance: 0.1,
      pass_threshold: 90,
    });
    return new Response(JSON.stringify({ id: "case-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "cases", "create", "suite-1",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--title", "Monthly revenue",
      "--question", "What was revenue last month?",
      "--category", "Revenue",
      "--expected-sql", "select sum(amount) from orders",
      "--expected-values", '[1200,"USD"]',
      "--required-tool", "query_database,format_answer",
      "--forbidden-tool", "web_search",
      "--tag", "revenue",
      "--tag", "critical",
      "--evaluator-config", '{"answer_similarity_weight":0.5}',
      "--numeric-tolerance", "0.1",
      "--pass-threshold", "90",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { id: "case-1" });
});

test("evals cases update accepts a category", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/cases/case-1");
    assert.equal(init.method, "PATCH");
    assert.deepEqual(JSON.parse(init.body), { category: "Finance" });
    return new Response(JSON.stringify({ id: "case-1", category: "Finance" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "cases", "update", "case-1",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--category", "Finance",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { id: "case-1", category: "Finance" });
});

test("evals runs create sends selected case IDs", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/runs");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      suite_id: "suite-1",
      label: "Focused smoke run",
      case_ids: ["case-1", "case-2", "case-3"],
      categories: ["Revenue", "Finance", "Sales, Americas"],
    });
    return new Response(JSON.stringify({ run_id: "run-1", status: "queued" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "runs", "create", "suite-1",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--label", "Focused smoke run",
      "--case", "case-1,case-2",
      "--case-id", "case-3",
      "--category", "Revenue",
      "--category", "Finance",
      "--category", "Sales, Americas",
      "--category", "Revenue",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { run_id: "run-1", status: "queued" });
});

test("evals runs create can disable the semantic layer", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/runs");
    assert.deepEqual(JSON.parse(init.body), {
      suite_id: "suite-1",
      use_semantic_layer: false,
    });
    return new Response(JSON.stringify({ run_id: "run-1", status: "queued" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "runs", "create", "suite-1",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--no-semantic-layer",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { run_id: "run-1", status: "queued" });
});

test("evals runs create sends the case concurrency limit", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/runs");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      suite_id: "suite-1",
      case_concurrency: 4,
    });
    return new Response(JSON.stringify({ run_id: "run-1", status: "queued" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "runs", "create", "suite-1",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--concurrency", "4",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { run_id: "run-1", status: "queued" });
});

test("evals runs create validates the case concurrency limit", async () => {
  for (const concurrency of ["0", "9", "2.5", "many"]) {
    await assert.rejects(
      main([
        "evals", "runs", "create", "suite-1",
        "--base-url", "https://answerlayer.example",
        "--api-key", "al_live_test",
        "--concurrency", concurrency,
      ], {
        env: {},
        stdin: readableStdin(),
        stdout: captureStream(),
        stderr: captureStream(),
      }),
      /Expected --concurrency to be an integer from 1 to 8/,
    );
  }
});

test("evals runs create-batch sends suite ids and shared configuration", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/runs/batch");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      suite_ids: ["suite-1", "suite-2", "suite-3"],
      label: "Release candidate",
      model: "moonshotai.kimi-k2.5",
      use_semantic_layer: false,
      case_concurrency: 4,
    });
    return new Response(JSON.stringify({
      runs: [
        { suite_id: "suite-1", run_id: "run-1", status: "queued" },
        { suite_id: "suite-2", run_id: "run-2", status: "queued" },
        { suite_id: "suite-3", run_id: "run-3", status: "queued" },
      ],
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "runs", "create-batch", "suite-1",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--suite", "suite-2,suite-3",
      "--label", "Release candidate",
      "--model", "moonshotai.kimi-k2.5",
      "--no-semantic-layer",
      "--concurrency", "4",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(JSON.parse(output.text()).runs.length, 3);
});

test("evals runs create-batch validates suite selection", async () => {
  const common = [
    "--base-url", "https://answerlayer.example",
    "--api-key", "al_live_test",
  ];

  await assert.rejects(
    main(["evals", "runs", "create-batch", "suite-1", ...common], {
      env: {},
      stdin: readableStdin(),
      stdout: captureStream(),
      stderr: captureStream(),
    }),
    /requires 2 to 20 suite ids/,
  );
  await assert.rejects(
    main([
      "evals", "runs", "create-batch", "suite-1", "suite-1", ...common,
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: captureStream(),
      stderr: captureStream(),
    }),
    /requires distinct suite ids/,
  );
});

test("evals runs create-batch validates concurrency from structured input", async () => {
  for (const concurrency of [9, 2.5, true, [4], { value: 4 }, null]) {
    await assert.rejects(
      main([
        "evals", "runs", "create-batch",
        "--base-url", "https://answerlayer.example",
        "--api-key", "al_live_test",
        "--data", JSON.stringify({
          suite_ids: ["suite-1", "suite-2"],
          case_concurrency: concurrency,
        }),
      ], {
        env: {},
        stdin: readableStdin(),
        stdout: captureStream(),
        stderr: captureStream(),
      }),
      /Expected --concurrency to be an integer from 1 to 8/,
    );
  }
});

test("evals runs update renames a run", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/runs/run-1");
    assert.equal(init.method, "PATCH");
    assert.deepEqual(JSON.parse(init.body), { label: "Prompt experiment B" });
    return new Response(JSON.stringify({ id: "run-1", label: "Prompt experiment B" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "runs", "update", "run-1",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--label", "Prompt experiment B",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { id: "run-1", label: "Prompt experiment B" });
});

test("evals runs update requires a label", async () => {
  await assert.rejects(
    main([
      "evals", "runs", "update", "run-1",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: captureStream(),
      stderr: captureStream(),
    }),
    /evals runs update requires --label/,
  );
});
test("evals runs compare sends the requested baseline", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/runs/run-2/compare?baseline_run_id=run-1");
    assert.equal(init.method, "GET");
    return new Response(JSON.stringify({ regressions: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "runs", "compare", "run-2",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--baseline", "run-1",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { regressions: 0 });
});

test("evals runs analyze preserves structured findings and evidence identifiers", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();
  const analysis = {
    run_id: "run-2",
    analysis_version: "1",
    method: "deterministic_rules",
    analysis_status: "complete",
    total_case_count: 1,
    analyzed_case_count: 1,
    failed_case_count: 1,
    warning_case_count: 0,
    unclassified_case_count: 0,
    findings: [{
      code: "sql_result_mismatch",
      category: "query_generation_or_sql_execution",
      title: "SQL results did not match",
      severity: "failure",
      observed_summary: "1 case returned SQL rows that did not satisfy the configured result check.",
      recommendations: [],
      affected_case_count: 1,
      affected_case_result_ids: ["result-1"],
      affected_cases_truncated: false,
      evidence_count: 1,
      evidence_ids: ["case_result:result-1:criterion.result_match"],
      evidence_truncated: false,
    }],
    evidence_count: 1,
    evidence: [{
      id: "case_result:result-1:criterion.result_match",
      case_result_id: "result-1",
      eval_case_id: "case-1",
      case_title: "Monthly revenue",
      source: "criterion.result_match",
      observation: "The SQL result match check failed with score 0.",
      details: { score: 0 },
      details_truncated: false,
    }],
    evidence_truncated: false,
    caveat: "Findings summarize stored evidence.",
  };

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/evals/runs/run-2/analysis");
    assert.equal(init.method, "GET");
    return new Response(JSON.stringify(analysis), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "evals", "runs", "analyze", "run-2",
      "--base-url", "https://answerlayer.example",
      "--api-key", "al_live_test",
      "--json",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), analysis);
});

function readableStdin() {
  const stream = Readable.from([]);
  stream.isTTY = true;
  return stream;
}

function localFixture(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-local-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const configPath = path.join(tempDir, "config.json");
  const output = captureStream();
  const commands = [];
  const resolvedImage = "public.ecr.aws/s8d9x7y7/answerlayer@sha256:abc123";
  const fixture = {
    tempDir,
    runtimeDir,
    configPath,
    output,
    commands,
    resolvedImage,
    psOutput: "",
    apiRequests: [],
    demoApi: {
      connections: [],
      savedQueries: [],
      semantic: Object.fromEntries(["entities", "relationships", "dimensions", "measures"].map(resource => [resource, []])),
    },
  };

  fixture.io = {
    env: { ANSWERLAYER_LOCAL_DIR: runtimeDir, ANSWERLAYER_CONFIG: configPath },
    stdin: readableStdin(),
    stdout: output,
    stderr: captureStream(),
    availableBytes: options.availableBytes ?? 10 * 1024 * 1024 * 1024,
    portIsAvailable: () => options.portIsAvailable ?? true,
    sleep: async () => {},
    fetch: async (url, init = {}) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname === "/readyz") return new Response(JSON.stringify({ status: "ready" }));
      assert.equal(init.headers["X-API-Key"], "al_local_secret");
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      fixture.apiRequests.push({ method, pathname: requestUrl.pathname, search: requestUrl.search, body });
      const json = data => new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });

      if (requestUrl.pathname === "/api/v1/auth/me") return json({ email: "local@answerlayer.test" });
      if (requestUrl.pathname === "/api/v1/connections/" && method === "GET") return json(fixture.demoApi.connections);
      if (requestUrl.pathname === "/api/v1/connections/" && method === "POST") {
        const connection = {
          id: "demo-connection-id",
          name: body.name,
          db_type: body.db_type,
          status: "active",
          config: {
            pg_host: body.config.host,
            pg_port: body.config.port,
            db_name: body.config.database_name,
            pg_username: body.config.username,
          },
        };
        fixture.demoApi.connections.push(connection);
        return json(connection);
      }
      const semanticMatch = requestUrl.pathname.match(/^\/api\/v1\/semantic\/(entities|relationships|dimensions|measures)$/);
      if (semanticMatch && method === "GET") {
        const resource = semanticMatch[1];
        return json({ [resource]: fixture.demoApi.semantic[resource] });
      }
      if (semanticMatch && method === "POST") {
        const resource = semanticMatch[1];
        const item = { id: `${resource}-${fixture.demoApi.semantic[resource].length + 1}`, ...body };
        fixture.demoApi.semantic[resource].push(item);
        return json(item);
      }
      if (requestUrl.pathname === "/api/v1/saved-queries" && method === "GET") {
        return json({ saved_queries: fixture.demoApi.savedQueries, total: fixture.demoApi.savedQueries.length });
      }
      if (requestUrl.pathname === "/api/v1/saved-queries" && method === "POST") {
        const item = { id: "demo-saved-query-id", ...body };
        fixture.demoApi.savedQueries.push(item);
        return json(item);
      }
      if (requestUrl.pathname === "/api/v1/query/demo-connection-id" && method === "POST") {
        assert.match(body.query, /FROM demo\.orders/);
        return json({
          columns: ["completed_order_count", "total_revenue"],
          rows: [[11, "12200.00"]],
          row_count: 1,
          total_rows: 1,
          execution_time_ms: 2,
        });
      }
      throw new Error(`Unexpected local fixture request: ${method} ${requestUrl}`);
    },
    runCommand(command, args, commandOptions) {
      commands.push([command, args, commandOptions]);
      if (args[0] === "version" && args.includes("--format")) {
        return { status: 0, stdout: `${options.dockerVersion || "27.3.1"}\n`, stderr: "" };
      }
      if (args[0] === "compose" && args[1] === "version" && args.includes("--short")) {
        return { status: 0, stdout: "2.32.4\n", stderr: "" };
      }
      if (args[0] === "info") return { status: 0, stdout: "linux/amd64\n", stderr: "" };
      if (args[0] === "image" && args[1] === "inspect") {
        return { status: 0, stdout: `${JSON.stringify([resolvedImage])}\n`, stderr: "" };
      }
      if (args.includes("ps") && args.includes("--format")) {
        return { status: 0, stdout: `${fixture.psOutput}\n`, stderr: "" };
      }
      if (args.includes("app.scripts.bootstrap_local")) {
        return {
          status: 0,
          stdout: "answerlayer init --base-url http://localhost:8000 --api-key al_local_secret\n",
          stderr: "",
        };
      }
      if (args.includes("psql") && (options.seedError || fixture.seedError)) {
        return { status: 1, stdout: "", stderr: options.seedError || fixture.seedError };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return fixture;
}

function countDemoCreateRequests(requests) {
  return Object.fromEntries(
    ["connections", "entities", "relationships", "dimensions", "measures", "saved-queries"].map(resource => {
      const pathName = resource === "connections"
        ? "/api/v1/connections/"
        : resource === "saved-queries"
          ? "/api/v1/saved-queries"
          : `/api/v1/semantic/${resource}`;
      return [resource, requests.filter(request => request.method === "POST" && request.pathname === pathName).length];
    }),
  );
}

function captureStream() {
  let body = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      body += chunk.toString();
      callback();
    },
  });
  stream.text = () => body;
  stream.clear = () => { body = ""; };
  return stream;
}
