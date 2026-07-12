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

test("local up clones, starts, bootstraps, verifies, and configures the local stack", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-local-"));
  const stackDir = path.join(tempDir, "core");
  const configPath = path.join(tempDir, "config.json");
  const commands = [];
  const output = captureStream();

  const runCommand = (command, args, options) => {
    commands.push([command, args, options]);
    if (command === "git" && args[0] === "clone") {
      fs.mkdirSync(path.join(stackDir, ".git"), { recursive: true });
      fs.mkdirSync(path.join(stackDir, "backend/app/scripts"), { recursive: true });
      fs.writeFileSync(path.join(stackDir, "docker-compose.yml"), "services: {}\n");
      fs.writeFileSync(path.join(stackDir, "Makefile"), "local-bootstrap:\n\t@true\n");
      fs.writeFileSync(path.join(stackDir, "backend/app/scripts/bootstrap_local.py"), "# local bootstrap\n");
      fs.writeFileSync(
        path.join(stackDir, ".env.example"),
        "ANTHROPIC_API_KEY=placeholder\nENCRYPTION_KEY=placeholder\n",
      );
    }
    if (command === "git" && args.includes("get-url")) {
      return { status: 0, stdout: "git@github.com:AnswerLayer/answerlayer-core.git\n", stderr: "" };
    }
    if (command === "docker" && args.includes("port")) {
      return { status: 0, stdout: "0.0.0.0:49152\n", stderr: "" };
    }
    if (command === "make") {
      return {
        status: 0,
        stdout: "answerlayer init --api-key al_local_secret --base-url http://localhost:8000\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/healthz")) return new Response("ok");
    assert.equal(String(url), "http://127.0.0.1:49152/api/v1/auth/me");
    assert.equal(init.headers["X-API-Key"], "al_local_secret");
    return new Response(JSON.stringify({ email: "local@answerlayer.test" }), {
      headers: { "content-type": "application/json" },
    });
  };

  await main(["local", "up", "--stack-dir", stackDir], {
    env: { ANTHROPIC_API_KEY: "sk-ant-local", ANSWERLAYER_CONFIG: configPath },
    stdin: readableStdin(),
    stdout: output,
    stderr: captureStream(),
    runCommand,
    fetch: fetchImpl,
    sleep: async () => {},
  });

  assert.deepEqual(commands.map(([command, args]) => [command, ...args]), [
    ["git", "--version"],
    ["docker", "compose", "version"],
    ["git", "clone", "--depth", "1", "https://github.com/AnswerLayer/answerlayer-core.git", stackDir],
    ["git", "-C", stackDir, "remote", "get-url", "origin"],
    ["docker", "compose", "up", "--build", "-d"],
    ["docker", "compose", "port", "answerlayer", "8000"],
    ["make", "local-bootstrap"],
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
    baseUrl: "http://127.0.0.1:49152",
    apiKey: "al_local_secret",
  });
  assert.equal(fs.statSync(path.join(stackDir, ".env")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(stackDir, ".env"), "utf8"), /ANTHROPIC_API_KEY=sk-ant-local/);
  assert.doesNotMatch(output.text(), /al_local_secret/);
  assert.match(output.text(), /Local AnswerLayer is ready/);
});

test("local up requires the provider key before creating a new checkout", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-local-"));
  const stackDir = path.join(tempDir, "core");
  const commands = [];

  await assert.rejects(
    main(["local", "up", "--stack-dir", stackDir], {
      env: {},
      stdin: readableStdin(),
      stdout: captureStream(),
      stderr: captureStream(),
      runCommand(command, args) {
        commands.push([command, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
    /Set ANTHROPIC_API_KEY/,
  );

  assert.equal(fs.existsSync(stackDir), false);
  assert.deepEqual(commands, [["git", "--version"], ["docker", "compose", "version"]]);
});

test("local up rejects an existing checkout with a non-AnswerLayer origin", async () => {
  const stackDir = createCoreCheckout();
  fs.writeFileSync(path.join(stackDir, ".env"), "ANTHROPIC_API_KEY=local\n");

  await assert.rejects(
    main(["local", "up", "--stack-dir", stackDir], {
      env: {},
      stdin: readableStdin(),
      stdout: captureStream(),
      stderr: captureStream(),
      runCommand(command, args) {
        if (command === "git" && args.includes("get-url")) {
          return { status: 0, stdout: "https://github.com/example/another-repo.git\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
    /does not use the official AnswerLayer core origin/,
  );
});

test("local up refuses to create an environment from an incompatible template", async () => {
  const stackDir = createCoreCheckout();
  fs.writeFileSync(path.join(stackDir, ".env.example"), "ANTHROPIC_API_KEY=placeholder\n");

  await assert.rejects(
    main(["local", "up", "--stack-dir", stackDir], {
      env: { ANTHROPIC_API_KEY: "sk-ant-local" },
      stdin: readableStdin(),
      stdout: captureStream(),
      stderr: captureStream(),
      runCommand(command, args) {
        if (command === "git" && args.includes("get-url")) {
          return { status: 0, stdout: "https://github.com/AnswerLayer/answerlayer-core.git\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
    /must contain exactly one ENCRYPTION_KEY= entry/,
  );

  assert.equal(fs.existsSync(path.join(stackDir, ".env")), false);
});

test("defaults the base URL to the hosted SaaS when none is configured", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://app.answerlayer.io/api/v1/auth/me");
    return new Response(JSON.stringify({ email: "user@example.com" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main(["auth", "me", "--api-key", "al_live_test"], {
      env: {},
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

function readableStdin() {
  const stream = Readable.from([]);
  stream.isTTY = true;
  return stream;
}

function createCoreCheckout() {
  const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-core-"));
  fs.mkdirSync(path.join(stackDir, ".git"));
  fs.mkdirSync(path.join(stackDir, "backend/app/scripts"), { recursive: true });
  fs.writeFileSync(path.join(stackDir, "docker-compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(stackDir, ".env.example"), "ANTHROPIC_API_KEY=x\nENCRYPTION_KEY=x\n");
  fs.writeFileSync(path.join(stackDir, "Makefile"), "local-bootstrap:\n\t@true\n");
  fs.writeFileSync(path.join(stackDir, "backend/app/scripts/bootstrap_local.py"), "# local bootstrap\n");
  return stackDir;
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
  return stream;
}
