---
name: answerlayer
description: Query databases in natural language with AnswerLayer. Use when the user wants to set up or configure AnswerLayer, connect to their data, ask analytical or business questions about a database (revenue, users, counts, "top N", trends, metrics), run SQL through AnswerLayer, or manage AnswerLayer connections, saved queries, the semantic layer, or dashboards.
---

# AnswerLayer

AnswerLayer turns natural-language questions into governed SQL against the user's
connected databases. This skill drives the **AnswerLayer CLI**, which talks to
the AnswerLayer API with an API key.

Work in three steps: **resolve the CLI → ensure it's configured → use it.**

When a user asks to evaluate AnswerLayer locally or against a real database
without creating a hosted account, use the local-stack workflow below instead
of the hosted-key workflow.

## Local stack workflow

Use this only when the user explicitly wants a local evaluation or authorizes
you to start Docker containers and create a local API key. Explain the commands
that will run and get confirmation before each state-changing phase.

Install this bundled skill with `answerlayer skills install` when it is not
already available in the Codex skills directory.

1. Install the CLI if it is not already available:

   ```bash
   npm install -g @answerlayer/cli
   ```

2. Ask the user to set their Anthropic key privately in their own terminal. Do
   not ask them to paste it into chat or put it in shell history:

   ```bash
   read -s ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY
   ```

3. After confirmation, run the complete local setup:

   ```bash
   answerlayer local up
   ```

   This verifies Git and Docker, clones the core stack to
   `~/.answerlayer/core` when needed, creates a permission-restricted `.env`
   with a generated encryption key, starts Docker Compose, waits for health,
   creates the local identity and scoped key, verifies it, and configures the
   CLI. It captures the one-time key rather than printing it. Use
   `--stack-dir <directory>` to reuse a different core checkout; when that
   checkout already has a `.env`, `ANTHROPIC_API_KEY` need not be exported.

4. Before connecting real data, require a dedicated database account that is
   restricted to approved schemas and `SELECT` only. Show the proposed
   connection host, database, and username, then get confirmation before
   running `connections create` or any query. Put the password only in a local,
   permission-restricted JSON file; never print it or commit it.

5. Start with a small approved schema and read-only inspection. Confirm before
   creating connections, generating semantic objects, or executing queries.

This workflow is for Docker Compose development only. Do not run
`local-bootstrap` against a hosted or customer deployment.

## 1. Resolve the CLI command (`AL`)

Pick the command once per session and reuse it. Run:

```bash
command -v answerlayer.js >/dev/null && echo answerlayer.js \
  || command -v answerlayer >/dev/null && echo answerlayer \
  || echo "npx -y @answerlayer/cli"
```

- `answerlayer.js` — ships with this plugin and is on your PATH (works offline).
- `answerlayer` — a global install (`npm i -g @answerlayer/cli`).
- `npx -y @answerlayer/cli` — fallback; downloads from npm on first use.

Use whichever it prints as `AL` below. They all run identical code.

## 2. Ensure it's configured

The CLI needs a base URL (defaults to `https://app.answerlayer.io`) and an API
key sent as `X-API-Key`. Check whether credentials already exist:

```bash
AL auth me --json
```

- If it returns the caller's identity, you're configured — continue to step 3.
- If it errors with a missing-key/auth error, set credentials up:

  1. Ask the user for their **API key**. Also ask for their **host** only if
     they're on a BYOC / self-hosted install; otherwise the default
     `https://app.answerlayer.io` is correct.
  2. Configure (omit `--base-url` to accept the default):

     ```bash
     AL init --api-key <KEY> [--base-url https://answerlayer.their-host.com]
     ```

     This verifies the key before writing `~/.answerlayer/config.json` (mode
     0600). Alternatively the user can export `ANSWERLAYER_API_KEY` (and
     optionally `ANSWERLAYER_BASE_URL`).
  3. Re-run `AL auth me --json` to confirm.

**Never print, echo, or log the API key.** Pass it straight to `init`. Tell
the user keys are created in the AnswerLayer dashboard under **Settings → API
Keys** and are shown only once.

## 3. Use it

Most questions need a **connection** (a database). List them and grab an `id`:

```bash
AL connections list            # human table; add --json to parse
```

### Ask questions in natural language (preferred for analytical questions)

```bash
# First question — use --json to capture the session id for follow-ups
AL inquiry ask --connection <connection-id> --json "What was revenue last month?"

# Follow-up in the same conversation (carries prior context)
AL inquiry ask --session <session-id> --json "Break that down by region"
```

The JSON includes `session_id`, `final_response`, and `sql_queries`. Show the
user `final_response`; surface the SQL when they want to see how it was derived.
Without `--json` it prints the answer followed by the SQL as plain text.

### Run SQL directly

```bash
AL query run <connection-id> --sql "select count(*) from orders" --format table
AL query run <connection-id> --file ./report.sql --format csv
AL query validate <connection-id> --sql "select * from orders"
```

### Other resources

These follow `AL <group> <command>`. Run `AL <group> --help` (or `AL --help`)
to see exact flags before using one:

- `saved-queries` — list / get / create / execute reusable queries
- `semantic` — entities, relationships, measures, metrics, dimensions, filters
  (most need `--connection <id>`)
- `dashboards`, `tiles` — build and read dashboards
- `documents` — upload business-context docs and link them to connections
- `connections` — create / test / inspect schema
- `metadata`, `api-keys`, `users`, `org`, `billing`, `stats`

## Conventions

- Prefer `inquiry ask` for analytical/business questions; use `query run` only
  when the user gives or wants explicit SQL.
- Add `--json` whenever you need to parse output programmatically; query results
  also support `--format table|json|csv`.
- **Read freely, but confirm before writes.** `create`, `update`, `delete`,
  `revoke`, `approve`, `deploy`, and `assign`/`unassign` change state — show the
  user what you're about to run and get a yes first.
- If a command fails with a `403` / missing-scope error, the API key lacks a
  scope (e.g. `inquiry:execute`, `query:execute`, `connection:read`). Tell the
  user which scope to add to their key.
- For the full command surface, run `AL --help` or see the project README.
