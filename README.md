# AnswerLayer CLI

Open-source command line client for the AnswerLayer API.

Use it three ways: as a global command, on demand with `npx`, or as a [Claude
Code plugin](#use-with-claude-code) that lets Claude configure and drive it for
you.

## Install

```bash
npm install -g @answerlayer/cli
```

Or run it without installing:

```bash
npx -y @answerlayer/cli --help
```

The CLI is zero-dependency and runs on Node 20+. It also runs on
[Bun](https://bun.sh), if you prefer it:

```bash
bun install -g @answerlayer/cli   # or: bunx @answerlayer/cli --help
```

For local development:

```bash
git clone https://github.com/AnswerLayer/answerlayer-cli.git
cd answerlayer-cli
npm link
```

## Use with Claude Code

This repo is also a Claude Code plugin. Installing it gives Claude the CLI (on
its PATH, no separate install) plus a skill that configures your host + API key
and then answers questions against your data.

```text
/plugin marketplace add AnswerLayer/answerlayer-cli
/plugin install answerlayer@answerlayer
```

Then just ask — for example *"set up AnswerLayer and tell me revenue last
month."* Claude will prompt for your API key (and host, if you're self-hosted),
run `answerlayer configure`, and start asking questions for you. Your key is
stored locally in `~/.answerlayer/config.json`; it is never sent anywhere except
to your AnswerLayer host as the `X-API-Key` header.

The plugin and the standalone CLI are the same tool — installing the plugin does
not change how `answerlayer` works from your terminal.

## Configure

Create an API key in AnswerLayer with the scopes needed by your workflow, then
initialize the CLI. `init` verifies the key before it writes the config file, so
an invalid or expired key never overwrites a working local setup:

```bash
answerlayer init --api-key al_live_...
```

The CLI talks to the hosted SaaS at `https://app.answerlayer.io` by default. For a
BYOC or self-hosted install, point it at your own URL:

```bash
answerlayer init --api-key al_live_... --base-url https://answerlayer.your-company.com
```

The first API key is currently created in the AnswerLayer app under **Settings →
API Keys**. A browser/device login flow is planned; until then, the CLI will tell
you exactly what credential is missing rather than saving an unverified value.

You can also skip the config file and use environment variables:

```bash
export ANSWERLAYER_API_KEY=al_live_...
export ANSWERLAYER_BASE_URL=https://answerlayer.your-company.com  # optional override
```

The CLI sends API keys using the `X-API-Key` header.

## Run locally with an agent

The package includes an `answerlayer` agent skill for evaluating AnswerLayer
against your own database without first creating a hosted account. Install it
for Codex with:

```bash
answerlayer skills install
```

This installs to `~/.codex/skills/answerlayer` by default. Use `--path` for a
different skill directory; an existing skill is never replaced unless you pass
`--force`.

The recommended path is one command:

```bash
answerlayer local quickstart
```

Quickstart asks for confirmation before it changes local state, then initializes
and starts the supported public-image runtime, authenticates the CLI, installs
the deterministic demo, and verifies the provider-free demo query. If no model
provider is configured during an interactive run, quickstart offers to collect
the Anthropic key through a hidden terminal prompt, verifies it, and continues
directly to one real model-backed inquiry. The key is never accepted as a
command argument or printed to output. Successful inquiry details are retained
in the local runtime state, so repeating quickstart reuses the verified session
instead of creating duplicate demo resources or inquiry sessions.

The provider step can be declined and resumed later by rerunning the same
`answerlayer local quickstart` command. Noninteractive `--json` runs never ask
for secret input and instead return a credential-free `provider-required`
handoff for an agent to report.

For agent automation after the user has explicitly approved starting
containers, use `answerlayer local quickstart --yes --json`. Progress is written
to stderr; stdout is one stable, credential-free JSON object containing the CLI
version, image digest, runtime directory, demo and provider status, local URL,
inquiry result, and next actions. `--yes` must not be used to bypass user
approval.

The underlying lifecycle commands remain available when manual control is
needed:

```bash
answerlayer local init
answerlayer local start
```

`local init` selects the CLI's supported public image by default. Use
`--image <tag-or-digest>` to select a different published version and `--port`
to change the local port. Fresh runtimes use `http://127.0.0.1:8172`; existing
runtimes keep their previously selected port. The CLI:

1. Verifies Docker, its architecture and version, the port, and available disk.
2. Pulls the public AnswerLayer image and pins its resolved immutable digest.
3. Generates permission-restricted Compose, state, and secret files in the
   platform application-data directory.
4. Starts Postgres, runs migrations, and waits for AnswerLayer readiness.
5. Creates a local-only organization and scoped key, verifies the key, and
   saves the CLI configuration without printing the key.
6. Seeds a versioned synthetic retail demo in a separate Postgres database,
   registers its dedicated read-only connection, creates starter semantic
   objects and a saved query, and verifies a deterministic result.

The local stack does not require a hosted AnswerLayer account, a source checkout,
private registry credentials, or a model-provider key for first boot. Add an
optional provider key later only when using features that call that provider.
The skill requires agent confirmation before it starts containers, creates a
connection, or sends queries to a real database, and it instructs agents not to
print or persist database passwords.

The demo is installed by default. Use `answerlayer local start --no-demo` to
skip it, or install/verify it later with:

```bash
answerlayer local demo
answerlayer local demo --json
```

`local demo --json` returns the demo version, connection ID, saved-query ID,
semantic-resource IDs, the verified result, and suggested natural-language
questions without returning credentials. The saved query works before a model
provider is configured:

```bash
answerlayer saved-queries execute <saved-query-id> --format table
```

Natural-language inquiry still requires provider configuration. Re-running the
demo command reuses the same connection and semantic resources rather than
duplicating them. `local reset --force` explicitly removes both application and
demo data because they share the selected runtime's isolated Postgres volume.

Configure Anthropic privately from your own terminal when you are ready to use
model-backed features:

```bash
answerlayer local provider set anthropic
answerlayer local provider status --json
```

The interactive command disables terminal echo while you enter the key. It
stores the credential only in the selected runtime's mode-0600 environment,
recreates the application container without touching Postgres, and verifies the
key with Anthropic's model-list API from inside that container. The key is never
accepted as a command argument or returned by status output.

For non-interactive automation, place the key in a mode-0600 file and pass only
its path:

```bash
answerlayer local provider set anthropic --from-file /secure/path/anthropic.key
# Or set ANSWERLAYER_PROVIDER_KEY_FILE to that path.
```

Use `local provider rotate anthropic` to replace a working key. If validation
fails, the previous credential is restored. Use
`local provider remove anthropic --force` to disable model-backed features while
preserving all application and demo data.

Inspect and manage the lifecycle with:

```bash
answerlayer local status [--json]
answerlayer local logs [--follow] [answerlayer|migrate|postgres]
answerlayer local stop                  # preserves Postgres data
answerlayer local upgrade               # moves to this CLI's supported default
answerlayer local upgrade --image <tag> # selects an explicit release
answerlayer local reset --force         # permanently deletes local data
```

The selected tag and resolved digest are recorded in `state.json` and displayed
by `local status`. Set `ANSWERLAYER_LOCAL_DIR` to override the application-data
directory or `ANSWERLAYER_LOCAL_IMAGE` to override the default image.
Each runtime directory receives stable, isolated Compose project, volume, and
network names, so stopping or resetting one runtime cannot affect another.

Useful scopes:

- `api_key:manage` for API key management
- `connection:read` for listing connections
- `query:execute` for raw SQL
- `saved_query:read`, `saved_query:execute`, and `saved_query:write` for saved-query workflows
- `semantic:read`, `semantic:write`, and `semantic:generate` for semantic-layer workflows
- `dashboard:read`, `dashboard:write`, `tile:read`, and `tile:write` for dashboard workflows
- `inquiry:read` to inspect inquiry sessions and evaluation suites/runs
- `inquiry:execute` for natural-language inquiry and to manage/run evaluations

## Commands

```bash
answerlayer health
answerlayer openapi --output openapi.json
answerlayer local init
answerlayer local start
answerlayer local quickstart --yes --json
answerlayer local demo --json
answerlayer local provider status --json
answerlayer local status
answerlayer local logs
answerlayer local stop

answerlayer connections list
answerlayer connections get <connection-id>
answerlayer connections create --data-file ./postgres-connection.json
answerlayer metadata structure <connection-id>

answerlayer query run <connection-id> --sql "select * from orders limit 10"
answerlayer query validate <connection-id> --sql "select * from orders"
answerlayer query run <connection-id> --file ./query.sql --format csv

answerlayer saved-queries list
answerlayer saved-queries create --name "Revenue by month" --connection <connection-id> --file ./revenue.sql
answerlayer saved-queries execute <saved-query-id> --format table

answerlayer semantic entities create --connection <connection-id> --name Orders --source-table public.orders --identifier id
answerlayer semantic metrics list --connection <connection-id>
answerlayer semantic metrics generate --connection <connection-id> --prompt "SaaS revenue metrics"

answerlayer inquiry ask --connection <connection-id> "What changed in revenue this month?"
answerlayer inquiry ask --session <session-id> "Break that down by region"
answerlayer inquiry models
answerlayer inquiry ask --connection <connection-id> --model claude-opus-4-6 "Investigate unusual revenue changes"

answerlayer evals suites create --name "Revenue checks" --connection <connection-id>
answerlayer evals cases create <suite-id> --title "Monthly revenue" --question "What was revenue last month?" --category Revenue --expected-sql "select sum(amount) from orders where ..." --oracle-sources '[{"kind":"external","title":"Revenue policy","url":"https://example.com/revenue-policy"}]'
answerlayer evals runs create <suite-id> --label "Before prompt change"
answerlayer evals runs create <suite-id> --case <case-id> --case <case-id> --label "Focused smoke run"
answerlayer evals runs create <suite-id> --category Revenue --category Finance --case <case-id> --label "Focused category run"
answerlayer evals runs create <suite-id> --model claude-opus-4-6 --label "Model comparison"
answerlayer evals runs create <suite-id> --concurrency 4 --label "Parallel smoke run"
answerlayer evals runs create-batch --suite <suite-id> --suite <suite-id> --concurrency 4 --label "Release candidate"
answerlayer evals runs update <run-id> --label "Prompt experiment B"
answerlayer evals runs compare <run-id> --baseline <baseline-run-id>
answerlayer evals runs analyze <run-id> --json

answerlayer dashboards create --title "Executive overview" --visibility org
answerlayer tiles create --title "Revenue" --source-type saved_query --source <saved-query-id>
answerlayer dashboards attach-tile <dashboard-id> --tile <tile-id> --x 0 --y 0 --w 6 --h 4

answerlayer documents upload ./definitions.md --title "Business definitions"
answerlayer documents link <document-id> --connection <connection-id>

answerlayer api-keys create --name "CI" --scope query:execute --scope saved_query:execute
```

Most read commands support `--json`. Query results support `--format table|json|csv`.

For complex create/update payloads, pass structured JSON:

```bash
answerlayer connections create --data-file ./connection.json
answerlayer dashboards update <dashboard-id> --data '{"default_filters":[{"key":"region","type":"string_enum","label":"Region"}]}'
answerlayer branding update --data-file ./branding.json
```

## Command groups

- Core: `api-keys`, `connections`, `metadata`, `query`, `query-results`
- Data products: `saved-queries`, `semantic`, `inquiry`, `evals`, `generation`, `tiles`, `dashboards`
- Supporting resources: `documents`, `branding`, `uploads`, `chains`, `users`, `org`, `roles`, `billing`, `stats`

## Development

```bash
npm test
```

The package intentionally has no runtime dependencies. It requires Node.js 20 or newer for built-in `fetch`.

## Releasing

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/).
Every push to `main` derives the next version from commit messages and publishes
to npm via OIDC — no manual version bump, tag, or token:

- `fix:` / `feat:` / `chore:` / unprefixed … → patch (`0.0.X`)
- `feat(minor): …` → minor (`0.X.0`)
- `type!: …` or `BREAKING CHANGE:` in the body → major (`X.0.0`)

## Related projects

- [`answerlayer-go`](https://github.com/AnswerLayer/answerlayer-go) — Go client/SDK for the Inquiry API.

## License

[Apache 2.0](LICENSE)
