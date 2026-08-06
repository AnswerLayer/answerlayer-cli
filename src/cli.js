import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnswerLayerClient } from "./client.js";
import { formatJson, formatList, formatQueryResult } from "./format.js";
import { DEFAULT_BASE_URL, readConfig, resolveAuth, writeConfig } from "./config.js";
import { localUp } from "./local.js";

const SEMANTIC_RESOURCES = new Set([
  "entities",
  "relationships",
  "measures",
  "metrics",
  "dimensions",
  "filters",
]);

export async function main(argv, io) {
  const parsed = parseArgs(argv);
  const [group, command, ...positionals] = parsed.positionals;

  if (!group || group === "help" || parsed.flags.help || parsed.flags.h) {
    write(io.stdout, helpText());
    return;
  }

  if (group === "configure") {
    return configure(parsed, io);
  }

  if (group === "skills") {
    return installSkill(command, parsed, io);
  }

  if (group === "init") {
    return initialize(parsed, io);
  }

  if (group === "local") {
    if (command !== "up") throw usage("Expected `answerlayer local up`");
    return localUp(parsed, io);
  }

  const { baseUrl, apiKey } = resolveAuth(parsed.flags, io.env);
  const client = new AnswerLayerClient({ baseUrl, apiKey });

  if (group === "health") return handleHealth(client, command, parsed, io);
  if (group === "openapi") return handleOpenApi(client, parsed, io);
  if (group === "auth") return handleAuth(client, command, parsed, io);
  if (group === "api-keys" || group === "keys") return handleApiKeys(client, command, positionals, parsed, io);
  if (group === "connections") return handleConnections(client, command, positionals, parsed, io);
  if (group === "metadata") return handleMetadata(client, command, positionals, parsed, io);
  if (group === "query") return handleQuery(client, command, positionals, parsed, io);
  if (group === "query-results" || group === "results") return handleQueryResults(client, command, positionals, parsed, io);
  if (group === "saved-queries" || group === "saved") return handleSavedQueries(client, command, positionals, parsed, io);
  if (group === "semantic") return handleSemantic(client, command, positionals, parsed, io);
  if (group === "inquiry") return handleInquiry(client, command, positionals, parsed, io);
  if (group === "evals" || group === "evaluations") return handleEvals(client, command, positionals, parsed, io);
  if (group === "generation") return handleGeneration(client, command, positionals, parsed, io);
  if (group === "tiles") return handleTiles(client, command, positionals, parsed, io);
  if (group === "dashboards") return handleDashboards(client, command, positionals, parsed, io);
  if (group === "documents" || group === "context-documents") return handleDocuments(client, command, positionals, parsed, io);
  if (group === "branding") return handleBranding(client, command, positionals, parsed, io);
  if (group === "uploads") return handleUploads(client, command, positionals, parsed, io);
  if (group === "chains") return handleChains(client, command, positionals, parsed, io);
  if (group === "users") return handleUsers(client, command, positionals, parsed, io);
  if (group === "org" || group === "organization") return handleOrganization(client, command, positionals, parsed, io);
  if (group === "roles") return handleRoles(client, command, positionals, parsed, io);
  if (group === "billing") return handleBilling(client, command, positionals, parsed, io);
  if (group === "stats") return handleStats(client, command, parsed, io);

  throw usage(`Unknown command group: ${group}`);
}

function configure(parsed, io) {
  const existing = readConfig(io.env);
  const baseUrl = firstValue(parsed.flags.baseUrl) || existing.baseUrl || DEFAULT_BASE_URL;
  const apiKey = firstValue(parsed.flags.apiKey) || existing.apiKey;

  if (!apiKey) {
    throw usage("configure requires --api-key (--base-url defaults to https://app.answerlayer.io)");
  }

  const configPath = writeConfig({ ...existing, baseUrl, apiKey }, io.env);
  write(io.stdout, `Saved AnswerLayer config to ${configPath}\n`);
}

function installSkill(command, parsed, io) {
  if (command !== "install") {
    throw usage("Expected `answerlayer skills install`");
  }

  const source = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../skills/answerlayer",
  );
  const codexHome = io.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const target = firstValue(parsed.flags.path) || path.join(codexHome, "skills", "answerlayer");

  if (fs.existsSync(target) && !parsed.flags.force) {
    throw usage(
      `Skill already exists at ${target}. Review it, then rerun with --force to replace it.`,
    );
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.cpSync(source, target, { recursive: true, force: true });
  write(io.stdout, `Installed AnswerLayer skill to ${target}\n`);
}

async function initialize(parsed, io) {
  const existing = readConfig(io.env);
  const { baseUrl } = resolveAuth(parsed.flags, io.env);
  const apiKey = firstValue(parsed.flags.apiKey);

  if (!apiKey) {
    throw usage(
      "init requires an explicit --api-key. Use the command printed by `make local-bootstrap`, or create a key under Settings → API Keys.",
    );
  }

  // Verify before writing so a typo or an expired key never replaces a working
  // local configuration.
  const client = new AnswerLayerClient({ baseUrl, apiKey });
  await client.rawRequest("GET", "/api/v1/auth/me");

  const configPath = writeConfig({ ...existing, baseUrl, apiKey }, io.env);
  write(io.stdout, `Verified API key and saved AnswerLayer config to ${configPath}\n`);
  write(io.stdout, "Next: answerlayer connections list\n");
}

async function handleHealth(client, command, parsed, io) {
  const pathName = command === "ready" ? "/api/v1/ready" : "/api/v1/health";
  return requestAndPrint(client, "GET", pathName, parsed, io, { auth: false, okText: "ok" });
}

async function handleOpenApi(client, parsed, io) {
  return requestAndPrint(client, "GET", "/openapi.json", parsed, io, { auth: false });
}

async function handleAuth(client, command, parsed, io) {
  if (command === "me" || !command) {
    return requestAndPrint(client, "GET", "/api/v1/auth/me", parsed, io);
  }
  if (command === "logout") {
    return requestAndPrint(client, "POST", "/api/v1/auth/logout", parsed, io);
  }
  throw usage(`Unknown auth command: ${command}`);
}

async function handleApiKeys(client, command, positionals, parsed, io) {
  if (command === "list" || !command) {
    return requestAndPrint(client, "GET", "/api/v1/api-keys/", parsed, io, {
      table: [
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "prefix", label: "Prefix" },
        { key: "is_active", label: "Active" },
        { key: "is_admin", label: "Admin" },
      ],
    });
  }

  if (command === "create") {
    const payload = await readData(parsed.flags, io, {
      name: firstValue(parsed.flags.name),
      scopes: csvOrRepeated(parsed.flags.scope),
      is_admin: Boolean(parsed.flags.admin),
      connection_id: firstValue(parsed.flags.connection),
      expires_at: firstValue(parsed.flags.expiresAt),
    });
    requirePayloadValue(payload, "name", "api-keys create requires --name");
    return requestAndPrint(client, "POST", "/api/v1/api-keys/", parsed, io, { body: payload });
  }

  if (command === "revoke" || command === "delete") {
    const id = requirePositional(positionals, 0, "API key id");
    return requestAndPrint(client, "DELETE", `/api/v1/api-keys/${encodeURIComponent(id)}`, parsed, io);
  }

  throw usage(`Unknown api-keys command: ${command}`);
}

async function handleConnections(client, command, positionals, parsed, io) {
  if (command === "supported" || command === "supported-types") {
    return requestAndPrint(client, "GET", "/api/v1/connections/supported_types", parsed, io, {
      table: [
        { key: "id", label: "ID" },
        { key: "label", label: "Name" },
        { key: "supported", label: "Supported" },
      ],
    });
  }

  if (command === "list" || !command) {
    return requestAndPrint(client, "GET", "/api/v1/connections/", parsed, io, {
      table: [
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "db_type", label: "Type" },
        { key: "status", label: "Status" },
      ],
    });
  }

  if (command === "get") {
    const id = requirePositional(positionals, 0, "connection id");
    return requestAndPrint(client, "GET", `/api/v1/connections/${encodeURIComponent(id)}`, parsed, io);
  }

  if (command === "create") {
    const payload = await readData(parsed.flags, io, {
      name: firstValue(parsed.flags.name),
      db_type: firstValue(parsed.flags.type) || firstValue(parsed.flags.dbType),
      config: parseJsonFlag(firstValue(parsed.flags.config), "config"),
    });
    return requestAndPrint(client, "POST", "/api/v1/connections/", parsed, io, { body: payload });
  }

  if (command === "update") {
    const id = requirePositional(positionals, 0, "connection id");
    return requestAndPrint(client, "PUT", `/api/v1/connections/${encodeURIComponent(id)}`, parsed, io, {
      body: await readData(parsed.flags, io),
    });
  }

  if (command === "delete") {
    const id = requirePositional(positionals, 0, "connection id");
    return requestAndPrint(client, "DELETE", `/api/v1/connections/${encodeURIComponent(id)}`, parsed, io);
  }

  if (command === "schema") {
    const id = requirePositional(positionals, 0, "connection id");
    return requestAndPrint(client, "GET", `/api/v1/connections/${encodeURIComponent(id)}/schema`, parsed, io);
  }

  if (command === "config-schema") {
    const dbType = requirePositional(positionals, 0, "database type");
    return requestAndPrint(client, "GET", `/api/v1/connections/config_schema/${encodeURIComponent(dbType)}`, parsed, io);
  }

  if (command === "check-limit") {
    return requestAndPrint(client, "GET", "/api/v1/connections/check_limit", parsed, io);
  }

  if (command === "request-type") {
    const dbType = firstValue(parsed.flags.type) || requirePositional(positionals, 0, "database type");
    return requestAndPrint(client, "POST", "/api/v1/connections/request_type", parsed, io, {
      body: { db_type: dbType },
    });
  }

  if (command === "test") {
    const id = firstValue(parsed.flags.connection);
    const payload = await readData(parsed.flags, io);
    const pathName = id
      ? `/api/v1/connections/${encodeURIComponent(id)}/test_existing`
      : "/api/v1/connections/test_new_connection";
    return requestAndPrint(client, "POST", pathName, parsed, io, { body: payload });
  }

  if (command === "preview-tables") {
    return requestAndPrint(client, "POST", "/api/v1/connections/preview_tables", parsed, io, {
      body: await readData(parsed.flags, io),
    });
  }

  throw usage(`Unknown connections command: ${command}`);
}

async function handleMetadata(client, command, positionals, parsed, io) {
  if (command === "structure") {
    const connectionId = firstValue(parsed.flags.connection) || requirePositional(positionals, 0, "connection id");
    return requestAndPrint(client, "GET", `/api/v1/metadata/structure/${encodeURIComponent(connectionId)}`, parsed, io, {
      query: { include_pii: firstValue(parsed.flags.includePii) },
    });
  }
  if (command === "tables") {
    const schemaId = requirePositional(positionals, 0, "schema id");
    return requestAndPrint(client, "GET", `/api/v1/metadata/tables/${encodeURIComponent(schemaId)}`, parsed, io);
  }
  if (command === "columns") {
    const tableId = requirePositional(positionals, 0, "table id");
    return requestAndPrint(client, "GET", `/api/v1/metadata/columns/${encodeURIComponent(tableId)}`, parsed, io);
  }
  if (command === "pii-summary") {
    const connectionId = firstValue(parsed.flags.connection) || requirePositional(positionals, 0, "connection id");
    return requestAndPrint(client, "GET", `/api/v1/metadata/${encodeURIComponent(connectionId)}/pii/summary`, parsed, io);
  }
  if (command === "pii-settings") {
    const connectionId = firstValue(parsed.flags.connection) || requirePositional(positionals, 0, "connection id");
    return requestAndPrint(client, "PUT", `/api/v1/metadata/${encodeURIComponent(connectionId)}/pii/settings`, parsed, io, {
      body: await readData(parsed.flags, io),
    });
  }
  if (command === "detect-pii") {
    const connectionId = firstValue(parsed.flags.connection) || requirePositional(positionals, 0, "connection id");
    return requestAndPrint(client, "POST", `/api/v1/metadata/${encodeURIComponent(connectionId)}/pii/detect-stream`, parsed, io, {
      body: await readData(parsed.flags, io, {}),
      rawDefault: true,
    });
  }
  throw usage(`Unknown metadata command: ${command}`);
}

async function handleQuery(client, command, positionals, parsed, io) {
  if (command !== "run" && command !== "validate" && command !== "export") {
    throw usage("Expected query run, query validate, or query export");
  }

  const connectionId = requirePositional(positionals, 0, "connection id");
  const sql = await readSql(parsed.flags, positionals.slice(1), io);
  const payload = queryPayload(parsed.flags, sql);

  if (command === "validate") {
    return requestAndPrint(client, "POST", `/api/v1/query/${encodeURIComponent(connectionId)}/validate`, parsed, io, {
      body: payload,
    });
  }

  if (command === "export") {
    const format = firstValue(parsed.flags.format) || "csv";
    return requestAndPrint(client, "POST", `/api/v1/query/${encodeURIComponent(connectionId)}/export`, parsed, io, {
      body: payload,
      query: { format },
      rawDefault: true,
    });
  }

  const result = await client.request("POST", `/api/v1/query/${encodeURIComponent(connectionId)}`, { body: payload });
  write(io.stdout, parsed.flags.json ? formatJson(result) : formatQueryResult(result, firstValue(parsed.flags.format) || "table"));
}

async function handleQueryResults(client, command, positionals, parsed, io) {
  if (command === "get" || command === "fetch" || !command) {
    const handle = requirePositional(positionals, 0, "result handle");
    return requestAndPrint(client, "GET", `/api/v1/query-results/${encodeURIComponent(handle)}`, parsed, io, {
      query: {
        cursor: firstValue(parsed.flags.cursor),
        limit: firstValue(parsed.flags.limit),
      },
    });
  }
  if (command === "delete") {
    const handle = requirePositional(positionals, 0, "result handle");
    return requestAndPrint(client, "DELETE", `/api/v1/query-results/${encodeURIComponent(handle)}`, parsed, io);
  }
  throw usage(`Unknown query-results command: ${command}`);
}

async function handleSavedQueries(client, command, positionals, parsed, io) {
  if (command === "list" || !command) {
    return requestAndPrint(client, "GET", "/api/v1/saved-queries", parsed, io, {
      tableDataKey: "saved_queries",
      table: [
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "visibility", label: "Visibility" },
        { key: "connection_id", label: "Connection" },
      ],
    });
  }
  if (command === "get") {
    const id = requirePositional(positionals, 0, "saved query id");
    return requestAndPrint(client, "GET", `/api/v1/saved-queries/${encodeURIComponent(id)}`, parsed, io);
  }
  if (command === "create") {
    const payload = await readData(parsed.flags, io, {
      name: firstValue(parsed.flags.name),
      description: firstValue(parsed.flags.description),
      visibility: firstValue(parsed.flags.visibility),
      sql: await optionalSql(parsed.flags, positionals, io),
      connection_id: firstValue(parsed.flags.connection),
    });
    return requestAndPrint(client, "POST", "/api/v1/saved-queries", parsed, io, { body: payload });
  }
  if (command === "from-turn") {
    const payload = await readData(parsed.flags, io, {
      inquiry_turn_id: firstValue(parsed.flags.turn),
      name: firstValue(parsed.flags.name),
      description: firstValue(parsed.flags.description),
      visibility: firstValue(parsed.flags.visibility),
    });
    return requestAndPrint(client, "POST", "/api/v1/saved-queries/from-inquiry-turn", parsed, io, { body: payload });
  }
  if (command === "update") {
    const id = requirePositional(positionals, 0, "saved query id");
    const payload = await readData(parsed.flags, io, {
      name: firstValue(parsed.flags.name),
      description: firstValue(parsed.flags.description),
      visibility: firstValue(parsed.flags.visibility),
      sql: await optionalSql(parsed.flags, positionals.slice(1), io),
      connection_id: firstValue(parsed.flags.connection),
    });
    return requestAndPrint(client, "PATCH", `/api/v1/saved-queries/${encodeURIComponent(id)}`, parsed, io, { body: payload });
  }
  if (command === "delete") {
    const id = requirePositional(positionals, 0, "saved query id");
    return requestAndPrint(client, "DELETE", `/api/v1/saved-queries/${encodeURIComponent(id)}`, parsed, io);
  }
  if (command === "approve" || command === "unapprove") {
    const id = requirePositional(positionals, 0, "saved query id");
    const method = command === "approve" ? "POST" : "DELETE";
    return requestAndPrint(client, method, `/api/v1/saved-queries/${encodeURIComponent(id)}/approve`, parsed, io);
  }
  if (command === "execute") {
    const id = requirePositional(positionals, 0, "saved query id");
    const result = await client.request("POST", `/api/v1/saved-queries/${encodeURIComponent(id)}/execute`, {
      body: {
        params: parseJsonFlag(firstValue(parsed.flags.params), "params"),
        row_limit: parseInteger(firstValue(parsed.flags.rowLimit), 1000),
        timeout: parseInteger(firstValue(parsed.flags.timeout), 30),
      },
    });
    write(io.stdout, parsed.flags.json ? formatJson(result) : formatQueryResult(result, firstValue(parsed.flags.format) || "table"));
    return;
  }
  throw usage(`Unknown saved-queries command: ${command}`);
}

async function handleSemantic(client, command, positionals, parsed, io) {
  const resource = command;
  if (!SEMANTIC_RESOURCES.has(resource)) {
    throw usage(`Expected semantic resource: ${Array.from(SEMANTIC_RESOURCES).join(", ")}`);
  }

  const [verb = "list", idOrRest, ...rest] = positionals;
  const base = `/api/v1/semantic/${resource}`;
  const connectionId = firstValue(parsed.flags.connection);
  const itemName = resource.replace(/s$/, "");
  const query = { connection_id: connectionId };

  if (verb === "list") {
    requireConnection(connectionId, `semantic ${resource} list`);
    return requestAndPrint(client, "GET", base, parsed, io, {
      query,
      tableDataKey: resource,
      table: [
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "entity", label: "Entity" },
        { key: "description", label: "Description" },
      ],
    });
  }
  if (verb === "get") {
    const id = requirePositional([idOrRest], 0, `${itemName} id`);
    return requestAndPrint(client, "GET", `${base}/${encodeURIComponent(id)}`, parsed, io, { query });
  }
  if (verb === "create") {
    requireConnection(connectionId, `semantic ${resource} create`);
    return requestAndPrint(client, "POST", base, parsed, io, {
      query,
      body: await semanticPayload(resource, parsed.flags, [idOrRest, ...rest].filter(Boolean), io),
    });
  }
  if (verb === "update") {
    requireConnection(connectionId, `semantic ${resource} update`);
    const id = requirePositional([idOrRest], 0, `${itemName} id`);
    return requestAndPrint(client, "PUT", `${base}/${encodeURIComponent(id)}`, parsed, io, {
      query,
      body: await semanticPayload(resource, parsed.flags, rest, io),
    });
  }
  if (verb === "delete") {
    requireConnection(connectionId, `semantic ${resource} delete`);
    const id = requirePositional([idOrRest], 0, `${itemName} id`);
    return requestAndPrint(client, "DELETE", `${base}/${encodeURIComponent(id)}`, parsed, io, { query });
  }
  if (verb === "delete-all") {
    requireConnection(connectionId, `semantic ${resource} delete-all`);
    return requestAndPrint(client, "DELETE", `${base}/all`, parsed, io, { query });
  }
  if (verb === "generate") {
    requireConnection(connectionId, `semantic ${resource} generate`);
    return requestAndPrint(client, "POST", `${base}/generate/stream`, parsed, io, {
      body: await readData(parsed.flags, io, {
        connection_id: connectionId,
        prompt: firstValue(parsed.flags.prompt),
        model: firstValue(parsed.flags.model),
        options: parseJsonFlag(firstValue(parsed.flags.options), "options"),
      }),
      rawDefault: true,
    });
  }

  throw usage(`Unknown semantic ${resource} command: ${verb}`);
}

async function handleInquiry(client, command, positionals, parsed, io) {
  if (command === "models") {
    return requestAndPrint(client, "GET", "/api/v1/inquiry/models", parsed, io, {
      tableDataKey: "models",
      tablePrefix: (data) => `Default model: ${data.default_model}\n\n`,
      table: [
        { key: "id", label: "ID" },
        { key: "label", label: "Model" },
        { key: "family", label: "Provider" },
        { key: "transport", label: "Transport" },
        { key: "description", label: "Description" },
      ],
    });
  }

  if (command === "ask") {
    const question = firstValue(parsed.flags.question) || positionals.join(" ");
    const connectionId = firstValue(parsed.flags.connection);
    if (!question.trim()) throw usage("inquiry ask requires a question");

    let sessionId = firstValue(parsed.flags.session);
    if (!sessionId) {
      if (!connectionId) throw usage("inquiry ask requires --connection when --session is not provided");
      const session = await client.request("POST", "/api/v1/inquiry/sessions", {
        body: { connection_id: connectionId, model: firstValue(parsed.flags.model) },
      });
      sessionId = session.session_id;
    }

    const result = await client.request("POST", `/api/v1/inquiry/sessions/${encodeURIComponent(sessionId)}/sync`, {
      body: { user_input: question },
    });
    if (parsed.flags.json) {
      write(io.stdout, formatJson({ session_id: sessionId, ...result }));
      return;
    }
    write(io.stdout, `${result.final_response}\n`);
    if (result.sql_queries && result.sql_queries.length > 0) {
      write(io.stdout, "\nSQL:\n");
      for (const sql of result.sql_queries) write(io.stdout, `${sql}\n`);
    }
    return;
  }

  if (command === "sessions" || command === "list") {
    return requestAndPrint(client, "GET", "/api/v1/inquiry/sessions", parsed, io, {
      query: {
        connection_id: firstValue(parsed.flags.connection),
        status: firstValue(parsed.flags.status),
        limit: firstValue(parsed.flags.limit),
        offset: firstValue(parsed.flags.offset),
      },
      table: [
        { key: "id", label: "ID" },
        { key: "connection_id", label: "Connection" },
        { key: "status", label: "Status" },
        { key: "turn_count", label: "Turns" },
      ],
    });
  }

  if (command === "create-session") {
    return requestAndPrint(client, "POST", "/api/v1/inquiry/sessions", parsed, io, {
      body: await readData(parsed.flags, io, {
        connection_id: firstValue(parsed.flags.connection),
        model: firstValue(parsed.flags.model),
      }),
    });
  }

  if (command === "session") {
    const id = requirePositional(positionals, 0, "session id");
    return requestAndPrint(client, "GET", `/api/v1/inquiry/sessions/${encodeURIComponent(id)}`, parsed, io);
  }

  if (command === "update-session") {
    const id = requirePositional(positionals, 0, "session id");
    return requestAndPrint(client, "PATCH", `/api/v1/inquiry/sessions/${encodeURIComponent(id)}`, parsed, io, {
      body: await readData(parsed.flags, io, {
        status: firstValue(parsed.flags.status),
        thread_summary: firstValue(parsed.flags.summary),
      }),
    });
  }

  if (command === "delete-session") {
    const id = requirePositional(positionals, 0, "session id");
    return requestAndPrint(client, "DELETE", `/api/v1/inquiry/sessions/${encodeURIComponent(id)}`, parsed, io);
  }

  if (command === "turn") {
    const sessionId = requirePositional(positionals, 0, "session id");
    const turnId = requirePositional(positionals, 1, "turn id");
    return requestAndPrint(client, "GET", `/api/v1/inquiry/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`, parsed, io);
  }

  throw usage(`Unknown inquiry command: ${command}`);
}

async function handleEvals(client, resource, positionals, parsed, io) {
  const [command, ...rest] = positionals;
  const base = "/api/v1/evals";

  if (resource === "suites" || resource === "suite") {
    if (command === "list" || !command) {
      return requestAndPrint(client, "GET", `${base}/suites`, parsed, io, {
        query: {
          connection_id: firstValue(parsed.flags.connection),
          include_inactive: parsed.flags.includeInactive || undefined,
        },
        table: [
          { key: "id", label: "ID" },
          { key: "name", label: "Name" },
          { key: "connection_id", label: "Connection" },
          { key: "version", label: "Version" },
          { key: "case_count", label: "Cases" },
          { key: "is_active", label: "Active" },
        ],
      });
    }

    if (command === "create") {
      const payload = await readData(parsed.flags, io, {
        name: firstValue(parsed.flags.name),
        connection_id: firstValue(parsed.flags.connection),
        description: firstValue(parsed.flags.description),
      });
      requirePayloadValue(payload, "name", "evals suites create requires --name");
      requirePayloadValue(payload, "connection_id", "evals suites create requires --connection");
      return requestAndPrint(client, "POST", `${base}/suites`, parsed, io, { body: payload });
    }

    const suiteId = requirePositional(rest, 0, "eval suite id");
    if (command === "get") return requestAndPrint(client, "GET", `${base}/suites/${encodeURIComponent(suiteId)}`, parsed, io);
    if (command === "update") {
      return requestAndPrint(client, "PATCH", `${base}/suites/${encodeURIComponent(suiteId)}`, parsed, io, {
        body: await readData(parsed.flags, io, {
          name: firstValue(parsed.flags.name),
          description: firstValue(parsed.flags.description),
          is_active: activeFlag(parsed.flags),
        }),
      });
    }
    if (command === "delete") return requestAndPrint(client, "DELETE", `${base}/suites/${encodeURIComponent(suiteId)}`, parsed, io);
    throw usage(`Unknown evals suites command: ${command}`);
  }

  if (resource === "cases" || resource === "case") {
    if (command === "create") {
      const suiteId = firstValue(parsed.flags.suite) || requirePositional(rest, 0, "eval suite id");
      return requestAndPrint(client, "POST", `${base}/suites/${encodeURIComponent(suiteId)}/cases`, parsed, io, {
        body: await readData(parsed.flags, io, evalCasePayload(parsed.flags)),
      });
    }

    const caseId = requirePositional(rest, 0, "eval case id");
    if (command === "update") {
      return requestAndPrint(client, "PATCH", `${base}/cases/${encodeURIComponent(caseId)}`, parsed, io, {
        body: await readData(parsed.flags, io, { ...evalCasePayload(parsed.flags), is_active: activeFlag(parsed.flags) }),
      });
    }
    if (command === "delete") return requestAndPrint(client, "DELETE", `${base}/cases/${encodeURIComponent(caseId)}`, parsed, io);
    throw usage(`Unknown evals cases command: ${command}`);
  }

  if (resource === "runs" || resource === "run") {
    if (command === "list" || !command) {
      return requestAndPrint(client, "GET", `${base}/runs`, parsed, io, {
        query: {
          suite_id: firstValue(parsed.flags.suite),
          limit: firstValue(parsed.flags.limit),
          offset: firstValue(parsed.flags.offset),
        },
        table: [
          { key: "id", label: "ID" },
          { key: "suite_id", label: "Suite" },
          { key: "label", label: "Label" },
          { key: "status", label: "Status" },
          { key: "suite_version", label: "Version" },
        ],
      });
    }

    if (command === "create") {
      const payload = await readData(parsed.flags, io, {
        suite_id: firstValue(parsed.flags.suite) || rest[0],
        label: firstValue(parsed.flags.label),
        model: firstValue(parsed.flags.model),
        use_semantic_layer: semanticLayerMode(parsed.flags),
        baseline_run_id: firstValue(parsed.flags.baseline),
        case_ids: optionalCsvOrRepeated(parsed.flags.case),
        categories: optionalDistinctRepeated(parsed.flags.category),
      });
      requirePayloadValue(payload, "suite_id", "evals runs create requires a suite id or --suite");
      return requestAndPrint(client, "POST", `${base}/runs`, parsed, io, { body: payload });
    }

    const runId = requirePositional(rest, 0, "eval run id");
    if (command === "get") {
      return requestAndPrint(client, "GET", `${base}/runs/${encodeURIComponent(runId)}`, parsed, io, {
        query: { include_semantic_snapshot: parsed.flags.includeSemanticSnapshot || undefined },
      });
    }
    if (command === "update") {
      const payload = await readData(parsed.flags, io, {
        label: firstValue(parsed.flags.label),
      });
      requirePayloadValue(payload, "label", "evals runs update requires --label");
      return requestAndPrint(client, "PATCH", `${base}/runs/${encodeURIComponent(runId)}`, parsed, io, {
        body: payload,
      });
    }
    if (command === "cancel") return requestAndPrint(client, "POST", `${base}/runs/${encodeURIComponent(runId)}/cancel`, parsed, io);
    if (command === "compare") {
      return requestAndPrint(client, "GET", `${base}/runs/${encodeURIComponent(runId)}/compare`, parsed, io, {
        query: { baseline_run_id: firstValue(parsed.flags.baseline) },
      });
    }
    throw usage(`Unknown evals runs command: ${command}`);
  }

  throw usage(`Expected evals resource: suites, cases, or runs`);
}

async function handleGeneration(client, command, positionals, parsed, io) {
  const base = "/api/v1/semantic/jobs";
  if (command === "start" || command === "create") {
    return requestAndPrint(client, "POST", base, parsed, io, {
      body: await readData(parsed.flags, io),
    });
  }
  if (command === "list" || !command) {
    return requestAndPrint(client, "GET", base, parsed, io, {
      query: { connection_id: firstValue(parsed.flags.connection) },
    });
  }
  const jobId = requirePositional(positionals, 0, "job id");
  if (command === "get") return requestAndPrint(client, "GET", `${base}/${encodeURIComponent(jobId)}`, parsed, io);
  if (command === "status") return requestAndPrint(client, "GET", `${base}/${encodeURIComponent(jobId)}/status`, parsed, io);
  if (command === "stream") return requestAndPrint(client, "GET", `${base}/${encodeURIComponent(jobId)}/stream`, parsed, io, { rawDefault: true });
  if (command === "cancel") return requestAndPrint(client, "POST", `${base}/${encodeURIComponent(jobId)}/cancel`, parsed, io);
  if (command === "questions") return requestAndPrint(client, "GET", `${base}/${encodeURIComponent(jobId)}/questions`, parsed, io);
  if (command === "guidance") return requestAndPrint(client, "POST", `${base}/${encodeURIComponent(jobId)}/guidance`, parsed, io, { body: await readData(parsed.flags, io) });
  if (command === "delete") return requestAndPrint(client, "DELETE", `${base}/${encodeURIComponent(jobId)}`, parsed, io);
  throw usage(`Unknown generation command: ${command}`);
}

async function handleTiles(client, command, positionals, parsed, io) {
  if (command === "list" || !command) {
    return requestAndPrint(client, "GET", "/api/v1/tiles", parsed, io, {
      query: { dashboard_id: firstValue(parsed.flags.dashboard) },
      tableDataKey: "tiles",
      table: [
        { key: "id", label: "ID" },
        { key: "title", label: "Title" },
        { key: "source_type", label: "Source" },
        { key: "visibility", label: "Visibility" },
      ],
    });
  }
  if (command === "get") {
    const id = requirePositional(positionals, 0, "tile id");
    return requestAndPrint(client, "GET", `/api/v1/tiles/${encodeURIComponent(id)}`, parsed, io);
  }
  if (command === "create") {
    return requestAndPrint(client, "POST", "/api/v1/tiles", parsed, io, {
      body: await readData(parsed.flags, io, {
        title: firstValue(parsed.flags.title) || firstValue(parsed.flags.name),
        description: firstValue(parsed.flags.description),
        visibility: firstValue(parsed.flags.visibility),
        source_type: firstValue(parsed.flags.sourceType),
        source_ref: firstValue(parsed.flags.source),
        visualization: parseJsonFlag(firstValue(parsed.flags.visualization), "visualization"),
      }),
    });
  }
  if (command === "update") {
    const id = requirePositional(positionals, 0, "tile id");
    return requestAndPrint(client, "PATCH", `/api/v1/tiles/${encodeURIComponent(id)}`, parsed, io, {
      body: await readData(parsed.flags, io, {
        title: firstValue(parsed.flags.title) || firstValue(parsed.flags.name),
        description: firstValue(parsed.flags.description),
        visibility: firstValue(parsed.flags.visibility),
        visualization: parseJsonFlag(firstValue(parsed.flags.visualization), "visualization"),
      }),
    });
  }
  if (command === "data") {
    const id = requirePositional(positionals, 0, "tile id");
    return requestAndPrint(client, "POST", `/api/v1/tiles/${encodeURIComponent(id)}/data`, parsed, io, {
      body: await readData(parsed.flags, io, { filters: parseJsonFlag(firstValue(parsed.flags.filters), "filters") }),
    });
  }
  if (command === "delete") {
    const id = requirePositional(positionals, 0, "tile id");
    return requestAndPrint(client, "DELETE", `/api/v1/tiles/${encodeURIComponent(id)}`, parsed, io);
  }
  throw usage(`Unknown tiles command: ${command}`);
}

async function handleDashboards(client, command, positionals, parsed, io) {
  if (command === "list" || !command) {
    return requestAndPrint(client, "GET", "/api/v1/dashboards", parsed, io, {
      tableDataKey: "dashboards",
      table: [
        { key: "id", label: "ID" },
        { key: "title", label: "Title" },
        { key: "visibility", label: "Visibility" },
        { key: "updated_at", label: "Updated" },
      ],
    });
  }
  if (command === "get" || command === "manifest" || command === "saved-queries") {
    const id = requirePositional(positionals, 0, "dashboard id");
    const suffix = command === "get" ? "" : `/${command}`;
    return requestAndPrint(client, "GET", `/api/v1/dashboards/${encodeURIComponent(id)}${suffix}`, parsed, io);
  }
  if (command === "create") {
    return requestAndPrint(client, "POST", "/api/v1/dashboards", parsed, io, {
      body: await readData(parsed.flags, io, {
        title: firstValue(parsed.flags.title) || firstValue(parsed.flags.name),
        description: firstValue(parsed.flags.description),
        visibility: firstValue(parsed.flags.visibility),
        default_filters: parseJsonFlag(firstValue(parsed.flags.filters), "filters"),
      }),
    });
  }
  if (command === "update") {
    const id = requirePositional(positionals, 0, "dashboard id");
    return requestAndPrint(client, "PATCH", `/api/v1/dashboards/${encodeURIComponent(id)}`, parsed, io, {
      body: await readData(parsed.flags, io, {
        title: firstValue(parsed.flags.title) || firstValue(parsed.flags.name),
        description: firstValue(parsed.flags.description),
        visibility: firstValue(parsed.flags.visibility),
        default_filters: parseJsonFlag(firstValue(parsed.flags.filters), "filters"),
      }),
    });
  }
  if (command === "delete" || command === "duplicate") {
    const id = requirePositional(positionals, 0, "dashboard id");
    const method = command === "delete" ? "DELETE" : "POST";
    const suffix = command === "delete" ? "" : "/duplicate";
    return requestAndPrint(client, method, `/api/v1/dashboards/${encodeURIComponent(id)}${suffix}`, parsed, io);
  }
  if (command === "tile-data") {
    const dashboardId = requirePositional(positionals, 0, "dashboard id");
    const tileId = requirePositional(positionals, 1, "tile id");
    return requestAndPrint(client, "POST", `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}/data`, parsed, io, {
      body: await readData(parsed.flags, io, {
        filters: parseJsonFlag(firstValue(parsed.flags.filters), "filters"),
        pagination: paginationPayload(parsed.flags),
        result_handle: firstValue(parsed.flags.resultHandle),
      }),
    });
  }
  if (command === "attach-tile") {
    const dashboardId = requirePositional(positionals, 0, "dashboard id");
    return requestAndPrint(client, "POST", `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/tiles`, parsed, io, {
      body: await readData(parsed.flags, io, {
        tile_id: firstValue(parsed.flags.tile),
        position: positionPayload(parsed.flags),
      }),
    });
  }
  if (command === "move-tile") {
    const dashboardId = requirePositional(positionals, 0, "dashboard id");
    const tileId = requirePositional(positionals, 1, "tile id");
    return requestAndPrint(client, "PATCH", `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}`, parsed, io, {
      body: await readData(parsed.flags, io, { position: positionPayload(parsed.flags) }),
    });
  }
  if (command === "detach-tile") {
    const dashboardId = requirePositional(positionals, 0, "dashboard id");
    const tileId = requirePositional(positionals, 1, "tile id");
    return requestAndPrint(client, "DELETE", `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}`, parsed, io);
  }
  if (command === "assignments") {
    const id = requirePositional(positionals, 0, "dashboard id");
    return requestAndPrint(client, "GET", `/api/v1/dashboards/${encodeURIComponent(id)}/assignments`, parsed, io);
  }
  if (command === "assign") {
    const id = requirePositional(positionals, 0, "dashboard id");
    return requestAndPrint(client, "POST", `/api/v1/dashboards/${encodeURIComponent(id)}/assignments`, parsed, io, {
      body: await readData(parsed.flags, io, {
        user_id: firstValue(parsed.flags.user),
        email: firstValue(parsed.flags.email),
      }),
    });
  }
  if (command === "unassign") {
    const dashboardId = requirePositional(positionals, 0, "dashboard id");
    const userId = firstValue(parsed.flags.user) || requirePositional(positionals, 1, "user id");
    return requestAndPrint(client, "DELETE", `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/assignments/${encodeURIComponent(userId)}`, parsed, io);
  }
  throw usage(`Unknown dashboards command: ${command}`);
}

async function handleDocuments(client, command, positionals, parsed, io) {
  if (command === "list" || !command) {
    return requestAndPrint(client, "GET", "/api/v1/context-documents/", parsed, io, {
      query: { limit: firstValue(parsed.flags.limit), offset: firstValue(parsed.flags.offset) },
      table: [
        { key: "id", label: "ID" },
        { key: "title", label: "Title" },
        { key: "document_type", label: "Type" },
        { key: "created_at", label: "Created" },
      ],
    });
  }
  if (command === "upload") {
    const file = firstValue(parsed.flags.file) || requirePositional(positionals, 0, "document file");
    return requestAndPrint(client, "POST", "/api/v1/context-documents/upload", parsed, io, {
      body: multipart({
        file,
        fields: {
          title: firstValue(parsed.flags.title) || firstValue(parsed.flags.name) || path.basename(file),
          description: firstValue(parsed.flags.description),
        },
      }),
    });
  }
  if (command === "get" || command === "connections") {
    const id = requirePositional(positionals, 0, "document id");
    const suffix = command === "connections" ? "/connections" : "";
    return requestAndPrint(client, "GET", `/api/v1/context-documents/${encodeURIComponent(id)}${suffix}`, parsed, io);
  }
  if (command === "update") {
    const id = requirePositional(positionals, 0, "document id");
    return requestAndPrint(client, "PATCH", `/api/v1/context-documents/${encodeURIComponent(id)}`, parsed, io, {
      body: await readData(parsed.flags, io, {
        title: firstValue(parsed.flags.title) || firstValue(parsed.flags.name),
        description: firstValue(parsed.flags.description),
      }),
    });
  }
  if (command === "delete") {
    const id = requirePositional(positionals, 0, "document id");
    return requestAndPrint(client, "DELETE", `/api/v1/context-documents/${encodeURIComponent(id)}`, parsed, io);
  }
  if (command === "link") {
    const id = requirePositional(positionals, 0, "document id");
    const connectionId = firstValue(parsed.flags.connection) || requirePositional(positionals, 1, "connection id");
    return requestAndPrint(client, "POST", `/api/v1/context-documents/${encodeURIComponent(id)}/link`, parsed, io, {
      body: { connection_id: connectionId },
    });
  }
  if (command === "unlink") {
    const id = requirePositional(positionals, 0, "document id");
    const connectionId = firstValue(parsed.flags.connection) || requirePositional(positionals, 1, "connection id");
    return requestAndPrint(client, "DELETE", `/api/v1/context-documents/${encodeURIComponent(id)}/link/${encodeURIComponent(connectionId)}`, parsed, io);
  }
  if (command === "for-connection") {
    const connectionId = firstValue(parsed.flags.connection) || requirePositional(positionals, 0, "connection id");
    return requestAndPrint(client, "GET", `/api/v1/context-documents/connections/${encodeURIComponent(connectionId)}/documents`, parsed, io);
  }
  throw usage(`Unknown documents command: ${command}`);
}

async function handleBranding(client, command, positionals, parsed, io) {
  if (command === "get" || !command) {
    return requestAndPrint(client, "GET", "/api/v1/branding", parsed, io);
  }
  if (command === "update") {
    return requestAndPrint(client, "PATCH", "/api/v1/branding", parsed, io, {
      body: await readData(parsed.flags, io),
    });
  }
  if (command === "upload") {
    const file = firstValue(parsed.flags.file) || requirePositional(positionals, 0, "asset file");
    return requestAndPrint(client, "POST", "/api/v1/branding/assets", parsed, io, {
      body: multipart({ file }),
    });
  }
  if (command === "extract") {
    const file = firstValue(parsed.flags.file) || requirePositional(positionals, 0, "design file");
    return requestAndPrint(client, "POST", "/api/v1/branding/extract", parsed, io, {
      body: multipart({ file }),
    });
  }
  if (command === "asset") {
    const name = requirePositional(positionals, 0, "asset name");
    return requestAndPrint(client, "GET", `/api/v1/branding/assets/${encodeURIComponent(name)}`, parsed, io, { rawDefault: true });
  }
  throw usage(`Unknown branding command: ${command}`);
}

async function handleUploads(client, command, positionals, parsed, io) {
  if (command !== "csv" && command !== "duckdb") {
    throw usage("Expected uploads csv or uploads duckdb");
  }

  const base = `/api/v1/${command}`;
  const action = positionals[0] || "upload";
  if (action === "upload") {
    const file = firstValue(parsed.flags.file) || requirePositional(positionals, 1, "file");
    const formFields = Object.fromEntries(allValues(parsed.flags.form).map((item) => parsePair(item, "--form")));
    const namedFields = command === "csv"
      ? {
          name: firstValue(parsed.flags.name),
          description: firstValue(parsed.flags.description),
          auto_pii_detection: firstValue(parsed.flags["auto-pii-detection"]),
          has_header: firstValue(parsed.flags["has-header"]),
          delimiter: firstValue(parsed.flags.delimiter),
          quote_char: firstValue(parsed.flags["quote-char"]),
          encoding: firstValue(parsed.flags.encoding),
        }
      : {
          name: firstValue(parsed.flags.name),
          description: firstValue(parsed.flags.description),
        };
    return requestAndPrint(client, "POST", `${base}/upload`, parsed, io, {
      body: multipart({ file, fields: { ...namedFields, ...formFields } }),
    });
  }
  if (action === "status") {
    const id = firstValue(parsed.flags.connection) || requirePositional(positionals, 1, "connection id");
    return requestAndPrint(client, "GET", `${base}/${encodeURIComponent(id)}/processing-status`, parsed, io);
  }
  if (command === "csv" && action === "reprocess") {
    const id = firstValue(parsed.flags.connection) || requirePositional(positionals, 1, "connection id");
    return requestAndPrint(client, "POST", `${base}/${encodeURIComponent(id)}/reprocess`, parsed, io);
  }
  throw usage(`Unknown uploads ${command} command: ${action}`);
}

async function handleChains(client, command, positionals, parsed, io) {
  if (command === "list" || !command) {
    return requestAndPrint(client, "GET", "/api/v1/chains/", parsed, io, {
      query: { limit: firstValue(parsed.flags.limit) },
    });
  }
  if (command === "answers") {
    const id = requirePositional(positionals, 0, "chain id");
    return requestAndPrint(client, "GET", `/api/v1/chains/${encodeURIComponent(id)}/answers`, parsed, io, {
      query: { limit: firstValue(parsed.flags.limit) },
    });
  }
  throw usage(`Unknown chains command: ${command}`);
}

async function handleUsers(client, command, positionals, parsed, io) {
  if (command === "me" || !command) return requestAndPrint(client, "GET", "/api/v1/users/me", parsed, io);
  if (command === "update-me") return requestAndPrint(client, "PUT", "/api/v1/users/me", parsed, io, { body: await readData(parsed.flags, io) });
  if (command === "list") return requestAndPrint(client, "GET", "/api/v1/users/", parsed, io);
  if (command === "get") {
    const id = requirePositional(positionals, 0, "user id");
    return requestAndPrint(client, "GET", `/api/v1/users/${encodeURIComponent(id)}`, parsed, io);
  }
  if (command === "update") {
    const id = requirePositional(positionals, 0, "user id");
    return requestAndPrint(client, "PUT", `/api/v1/users/${encodeURIComponent(id)}`, parsed, io, { body: await readData(parsed.flags, io) });
  }
  throw usage(`Unknown users command: ${command}`);
}

async function handleOrganization(client, command, positionals, parsed, io) {
  if (command === "me" || !command) return requestAndPrint(client, "GET", "/api/v1/organizations/me", parsed, io);
  if (command === "usage") return requestAndPrint(client, "GET", "/api/v1/organizations/me/usage", parsed, io);
  if (command === "update") {
    const id = requirePositional(positionals, 0, "organization id");
    return requestAndPrint(client, "PUT", `/api/v1/organizations/${encodeURIComponent(id)}/details`, parsed, io, { body: await readData(parsed.flags, io) });
  }
  if (command === "invite") {
    const id = requirePositional(positionals, 0, "organization id");
    return requestAndPrint(client, "POST", `/api/v1/organizations/${encodeURIComponent(id)}/invite_member`, parsed, io, { body: await readData(parsed.flags, io) });
  }
  if (command === "deployment") {
    const id = requirePositional(positionals, 0, "organization id");
    return requestAndPrint(client, "GET", `/api/v1/organizations/${encodeURIComponent(id)}/deployment`, parsed, io);
  }
  if (command === "deploy") {
    const id = requirePositional(positionals, 0, "organization id");
    return requestAndPrint(client, "POST", `/api/v1/organizations/${encodeURIComponent(id)}/deployment`, parsed, io, { body: await readData(parsed.flags, io) });
  }
  if (command === "delete-deployment") {
    const id = requirePositional(positionals, 0, "organization id");
    return requestAndPrint(client, "DELETE", `/api/v1/organizations/${encodeURIComponent(id)}/deployment`, parsed, io);
  }
  throw usage(`Unknown org command: ${command}`);
}

async function handleRoles(client, command, positionals, parsed, io) {
  if (command === "list" || !command) return requestAndPrint(client, "GET", "/api/v1/roles/", parsed, io);
  if (command === "create") return requestAndPrint(client, "POST", "/api/v1/roles/", parsed, io, { body: await readData(parsed.flags, io) });
  if (command === "get") {
    const id = requirePositional(positionals, 0, "role id");
    return requestAndPrint(client, "GET", `/api/v1/roles/${encodeURIComponent(id)}`, parsed, io);
  }
  if (command === "assign") {
    const roleId = requirePositional(positionals, 0, "role id");
    const userId = firstValue(parsed.flags.user) || requirePositional(positionals, 1, "user id");
    return requestAndPrint(client, "POST", `/api/v1/roles/${encodeURIComponent(roleId)}/users/${encodeURIComponent(userId)}`, parsed, io);
  }
  if (command === "unassign") {
    const roleId = requirePositional(positionals, 0, "role id");
    const userId = firstValue(parsed.flags.user) || requirePositional(positionals, 1, "user id");
    return requestAndPrint(client, "DELETE", `/api/v1/roles/${encodeURIComponent(roleId)}/users/${encodeURIComponent(userId)}`, parsed, io);
  }
  if (command === "sync-clerk") return requestAndPrint(client, "POST", "/api/v1/roles/sync_clerk_role", parsed, io, { body: await readData(parsed.flags, io) });
  throw usage(`Unknown roles command: ${command}`);
}

async function handleBilling(client, command, positionals, parsed, io) {
  const billingPaths = {
    status: ["GET", "/api/v1/billing/status"],
    plans: ["GET", "/api/v1/billing/plans"],
    products: ["GET", "/api/v1/billing/billing-products"],
    history: ["GET", "/api/v1/billing/history"],
    "financial-history": ["GET", "/api/v1/billing/financial-history"],
    "usage-trends": ["GET", "/api/v1/billing/usage/trends"],
    sync: ["POST", "/api/v1/billing/sync"],
    checkout: ["POST", "/api/v1/billing/checkout-session"],
    portal: ["POST", "/api/v1/billing/customer-portal-session"],
  };
  if (command === "prices") {
    const planId = requirePositional(positionals, 0, "plan id");
    return requestAndPrint(client, "GET", `/api/v1/billing/plans/${encodeURIComponent(planId)}/prices`, parsed, io);
  }
  const entry = billingPaths[command || "status"];
  if (entry) {
    const [method, pathName] = entry;
    const body = method === "GET" ? undefined : await readData(parsed.flags, io, {});
    return requestAndPrint(client, method, pathName, parsed, io, {
      query: {
        limit: firstValue(parsed.flags.limit),
        offset: firstValue(parsed.flags.offset),
        days: firstValue(parsed.flags.days),
      },
      body,
    });
  }
  throw usage(`Unknown billing command: ${command}`);
}

async function handleStats(client, command, parsed, io) {
  if (command === "answers" || !command) return requestAndPrint(client, "GET", "/api/v1/answer_stats/", parsed, io);
  if (command === "connections") return requestAndPrint(client, "GET", "/api/v1/connection_stats/", parsed, io);
  throw usage(`Unknown stats command: ${command}`);
}

function queryPayload(flags, sql) {
  return {
    query: sql,
    params: parseJsonFlag(firstValue(flags.params), "params") ?? null,
    row_limit: parseInteger(firstValue(flags.rowLimit), 1000),
    timeout: parseInteger(firstValue(flags.timeout), 30),
  };
}

function evalCasePayload(flags) {
  return {
    title: firstValue(flags.title),
    question: firstValue(flags.question),
    category: firstValue(flags.category),
    expected_answer: firstValue(flags.expectedAnswer),
    expected_sql: firstValue(flags.expectedSql) || firstValue(flags.sql),
    expected_values: parseJsonFlag(firstValue(flags.expectedValues), "expected-values"),
    required_tools: optionalCsvOrRepeated(flags.requiredTool),
    forbidden_tools: optionalCsvOrRepeated(flags.forbiddenTool),
    tags: optionalCsvOrRepeated(flags.tag),
    evaluator_config: parseJsonFlag(firstValue(flags.evaluatorConfig), "evaluator-config"),
    numeric_tolerance: parseNumber(firstValue(flags.numericTolerance), "numeric-tolerance"),
    pass_threshold: parseNumber(firstValue(flags.passThreshold), "pass-threshold"),
  };
}

function activeFlag(flags) {
  if (flags.active && flags.inactive) throw usage("Use only one of --active or --inactive");
  if (flags.active) return true;
  if (flags.inactive) return false;
  return undefined;
}

function semanticLayerMode(flags) {
  if (flags.useSemanticLayer && flags.noSemanticLayer) {
    throw usage("Use only one of --use-semantic-layer or --no-semantic-layer");
  }
  if (flags.useSemanticLayer) return true;
  if (flags.noSemanticLayer) return false;
  return undefined;
}

async function semanticPayload(resource, flags, positionals, io) {
  const common = {
    name: firstValue(flags.name) || positionals.join(" ") || undefined,
    description: firstValue(flags.description),
    entity: firstValue(flags.entity),
    source_table: firstValue(flags.sourceTable),
    identifier: firstValue(flags.identifier),
    temporal_key: firstValue(flags.temporalKey),
    expression: firstValue(flags.expression),
    type: firstValue(flags.type),
    sql: firstValue(flags.sql),
    filters: parseJsonFlag(firstValue(flags.filters), "filters"),
  };

  if (resource === "relationships") {
    Object.assign(common, {
      from_entity: firstValue(flags.from),
      to_entity: firstValue(flags.to),
      relationship_type: firstValue(flags.relationshipType),
      join_condition: firstValue(flags.join),
    });
  }

  return readData(flags, io, common);
}

async function readSql(flags, positionals, io) {
  const sql = firstValue(flags.sql);
  const file = firstValue(flags.file);

  if (sql) return sql;
  if (file) return fs.readFileSync(file, "utf8");
  if (positionals.length > 0) return positionals.join(" ");
  if (!io.stdin.isTTY) return await readAll(io.stdin);
  throw usage("SQL is required. Pass --sql, --file, a positional SQL string, or stdin.");
}

async function optionalSql(flags, positionals, io) {
  if (firstValue(flags.sql) || firstValue(flags.file) || positionals.length > 0) {
    return readSql(flags, positionals, io);
  }
  return undefined;
}

async function readData(flags, io, defaults = {}) {
  const file = firstValue(flags.dataFile);
  const inline = firstValue(flags.data);
  let data = {};

  if (file) {
    data = parseJsonFlag(fs.readFileSync(file, "utf8"), "data-file");
  } else if (inline) {
    data = parseJsonFlag(inline, "data");
  } else if (!io.stdin.isTTY) {
    const text = await readAll(io.stdin);
    if (text.trim()) data = parseJsonFlag(text, "stdin");
  }

  return dropUndefined({ ...defaults, ...data });
}

function multipart({ file, fields = {} }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(dropUndefined(fields))) {
    form.append(key, String(value));
  }
  const buffer = fs.readFileSync(file);
  form.append("file", new Blob([buffer]), path.basename(file));
  return form;
}

function positionPayload(flags) {
  const payload = {
    x: parseInteger(firstValue(flags.x), undefined),
    y: parseInteger(firstValue(flags.y), undefined),
    w: parseInteger(firstValue(flags.w), undefined),
    h: parseInteger(firstValue(flags.h), undefined),
  };
  return dropUndefined(payload);
}

function paginationPayload(flags) {
  const payload = {
    limit: parseInteger(firstValue(flags.limit), undefined),
    cursor: firstValue(flags.cursor),
  };
  const clean = dropUndefined(payload);
  return Object.keys(clean).length > 0 ? clean : undefined;
}

async function requestAndPrint(client, method, pathName, parsed, io, options = {}) {
  const result = await client.rawRequest(method, pathName, {
    auth: options.auth ?? true,
    query: options.query,
    body: options.body,
    headers: options.headers,
  });

  const output = firstValue(parsed.flags.output);
  if (output) {
    fs.writeFileSync(output, result.buffer);
    write(io.stdout, `Wrote ${result.buffer.length} bytes to ${output}\n`);
    return;
  }

  if (parsed.flags.include) {
    write(io.stdout, `HTTP ${result.status}\n`);
    for (const [key, value] of Object.entries(result.headers)) write(io.stdout, `${key}: ${value}\n`);
    write(io.stdout, "\n");
  }

  if (parsed.flags.raw || options.rawDefault) {
    io.stdout.write(result.buffer);
    if (result.buffer.length > 0 && result.buffer[result.buffer.length - 1] !== 10) write(io.stdout, "\n");
    return;
  }

  if (result.data === null) {
    write(io.stdout, parsed.flags.json ? "null\n" : `${options.okText || "ok"}\n`);
    return;
  }

  if (!parsed.flags.json && options.table) {
    const rows = options.tableDataKey ? result.data[options.tableDataKey] : result.data;
    if (Array.isArray(rows)) {
      if (options.tablePrefix) write(io.stdout, options.tablePrefix(result.data));
      write(io.stdout, formatList(rows, options.table));
      return;
    }
  }

  if (typeof result.data === "object" || parsed.flags.json) {
    write(io.stdout, formatJson(result.data));
    return;
  }

  write(io.stdout, result.text.endsWith("\n") ? result.text : `${result.text}\n`);
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const rawName = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
    const name = normalizeFlagName(rawName);
    const next = argv[index + 1];

    if (isBooleanFlag(rawName)) {
      setFlag(flags, name, true);
      continue;
    }

    if (inlineValue !== undefined) {
      setFlag(flags, name, inlineValue);
      continue;
    }

    if (next === undefined || next.startsWith("-")) {
      throw usage(`Missing value for ${rawName}`);
    }

    setFlag(flags, name, next);
    index += 1;
  }

  if (flags.help) positionals.unshift("help");
  return { flags, positionals };
}

function normalizeFlagName(rawName) {
  const aliases = {
    "-h": "help",
    "--help": "help",
    "--base-url": "baseUrl",
    "--api-key": "apiKey",
    "--json": "json",
    "--include": "include",
    "-i": "include",
    "--output": "output",
    "-o": "output",
    "--raw": "raw",
    "--data": "data",
    "--data-file": "dataFile",
    "--body": "data",
    "--body-file": "dataFile",
    "--name": "name",
    "--title": "title",
    "--description": "description",
    "--visibility": "visibility",
    "--connection": "connection",
    "--type": "type",
    "--db-type": "dbType",
    "--config": "config",
    "--file": "file",
    "-f": "file",
    "--sql": "sql",
    "-q": "sql",
    "--params": "params",
    "--row-limit": "rowLimit",
    "--timeout": "timeout",
    "--format": "format",
    "--scope": "scope",
    "--admin": "admin",
    "--expires-at": "expiresAt",
    "--include-pii": "includePii",
    "--source-table": "sourceTable",
    "--identifier": "identifier",
    "--temporal-key": "temporalKey",
    "--entity": "entity",
    "--expression": "expression",
    "--source-type": "sourceType",
    "--source": "source",
    "--visualization": "visualization",
    "--dashboard": "dashboard",
    "--tile": "tile",
    "--user": "user",
    "--email": "email",
    "--filters": "filters",
    "--result-handle": "resultHandle",
    "--cursor": "cursor",
    "--limit": "limit",
    "--offset": "offset",
    "--days": "days",
    "--x": "x",
    "--y": "y",
    "--w": "w",
    "--h": "h",
    "--prompt": "prompt",
    "--model": "model",
    "--use-semantic-layer": "useSemanticLayer",
    "--no-semantic-layer": "noSemanticLayer",
    "--options": "options",
    "--status": "status",
    "--summary": "summary",
    "--session": "session",
    "--question": "question",
    "--suite": "suite",
    "--suite-id": "suite",
    "--label": "label",
    "--baseline": "baseline",
    "--baseline-run": "baseline",
    "--case": "case",
    "--case-id": "case",
    "--category": "category",
    "--expected-answer": "expectedAnswer",
    "--expected-sql": "expectedSql",
    "--expected-values": "expectedValues",
    "--required-tool": "requiredTool",
    "--forbidden-tool": "forbiddenTool",
    "--tag": "tag",
    "--evaluator-config": "evaluatorConfig",
    "--numeric-tolerance": "numericTolerance",
    "--pass-threshold": "passThreshold",
    "--active": "active",
    "--inactive": "inactive",
    "--include-inactive": "includeInactive",
    "--include-semantic-snapshot": "includeSemanticSnapshot",
    "--turn": "turn",
    "--from": "from",
    "--to": "to",
    "--relationship-type": "relationshipType",
    "--join": "join",
    "--form": "form",
    "--stack-dir": "stackDir",
  };

  return aliases[rawName] || rawName.replace(/^-+/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function isBooleanFlag(rawName) {
  return ["--json", "--help", "-h", "--include", "-i", "--raw", "--admin", "--force", "--active", "--inactive", "--include-inactive", "--include-semantic-snapshot", "--use-semantic-layer", "--no-semantic-layer"].includes(rawName);
}

function setFlag(flags, name, value) {
  if (flags[name] === undefined) flags[name] = value;
  else if (Array.isArray(flags[name])) flags[name].push(value);
  else flags[name] = [flags[name], value];
}

function parseJsonFlag(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw usage(`Invalid JSON for --${name}: ${error.message}`);
  }
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw usage(`Expected an integer, received ${value}`);
  return parsed;
}

function parseNumber(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw usage(`Expected a number for --${name}, received ${value}`);
  return parsed;
}

function requirePositional(positionals, index, label) {
  const value = positionals[index];
  if (!value) throw usage(`Missing ${label}`);
  return value;
}

function requireConnection(connectionId, label) {
  if (!connectionId) throw usage(`${label} requires --connection <id>`);
}

function requirePayloadValue(payload, key, message) {
  if (!payload[key]) throw usage(message);
}

function csvOrRepeated(value) {
  const values = allValues(value);
  return values.flatMap((item) => String(item).split(",").map((part) => part.trim()).filter(Boolean));
}

function optionalCsvOrRepeated(value) {
  return value === undefined ? undefined : csvOrRepeated(value);
}

function optionalDistinctRepeated(value) {
  if (value === undefined) return undefined;
  const values = allValues(value)
    .map((item) => String(item).trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function allValues(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function dropUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function parsePair(value, flagName) {
  const index = value.indexOf("=");
  if (index === -1) throw usage(`Expected ${flagName} key=value`);
  const key = value.slice(0, index);
  const item = value.slice(index + 1);
  if (!key) throw usage(`Expected ${flagName} key=value`);
  return [key, item];
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function write(stream, text) {
  stream.write(text);
}

function usage(message) {
  const error = new Error(`${message}\n\n${helpText()}`);
  error.exitCode = 2;
  return error;
}

function helpText() {
  return `AnswerLayer CLI

Usage:
  answerlayer skills install [--path <directory>] [--force]
  answerlayer local up [--stack-dir <directory>]
  answerlayer init --api-key <key> [--base-url <url>]
  answerlayer configure --base-url <url> --api-key <key>
  answerlayer health
  answerlayer openapi --output openapi.json

Core:
  answerlayer api-keys list|create|revoke
  answerlayer connections supported|list|get|create|update|delete|schema|test
  answerlayer metadata structure|tables|columns|pii-summary|pii-settings|detect-pii
  answerlayer query run|validate|export <connection-id> --sql <sql>
  answerlayer query-results get|delete <handle>

Data products:
  answerlayer saved-queries list|get|create|update|delete|approve|unapprove|execute
  answerlayer semantic <entities|relationships|measures|metrics|dimensions|filters> list|get|create|update|delete|delete-all|generate
  answerlayer inquiry models|ask|sessions|create-session|session|update-session|delete-session|turn
  answerlayer evals suites list|create|get|update|delete
  answerlayer evals cases create|update|delete
  answerlayer evals runs list|create|get|update|cancel|compare
    case create/update accept --category <name>
    run create accepts --case <case-id> (repeat or comma-separate) and
    --category <name> (repeat; category and case selectors are unioned), and
    --use-semantic-layer or --no-semantic-layer
    update accepts --label <name>
  answerlayer generation start|list|get|status|stream|cancel|questions|guidance|delete
  answerlayer tiles list|get|create|update|data|delete
  answerlayer dashboards list|get|create|update|delete|duplicate|manifest|attach-tile|move-tile|detach-tile|assignments|assign|unassign|tile-data

Admin and supporting resources:
  answerlayer documents upload|list|get|update|delete|link|unlink|connections|for-connection
  answerlayer branding get|update|upload|extract|asset
  answerlayer uploads csv|duckdb upload|status|reprocess
  answerlayer chains list|answers
  answerlayer users me|update-me|list|get|update
  answerlayer org me|usage|update|invite|deployment|deploy|delete-deployment
  answerlayer roles list|create|get|assign|unassign|sync-clerk
  answerlayer billing status|plans|products|prices|checkout|portal|history|usage-trends
  answerlayer stats answers|connections

Common options:
  --base-url <url>       Env: ANSWERLAYER_BASE_URL
  --api-key <key>        Env: ANSWERLAYER_API_KEY
  --json                 Print JSON instead of table output when available.
  --data <json>          Structured request payload.
  --data-file <path>     Structured request payload file.
  --output, -o <path>    Write response bytes to a file.

SQL options:
  --sql, -q <sql>        SQL text.
  --file, -f <path>      Read SQL from a file, or upload a file for upload commands.
  --params <json>        Query parameters as JSON.
  --row-limit <n>        Row limit. Default: 1000.
  --timeout <sec>        Timeout in seconds. Default: 30.
`;
}
