# AnswerLayer CLI

Open-source command line client for the AnswerLayer API.

Use it three ways: as a global command, with `npx`, or as a [Claude Code
plugin](#use-with-claude-code) that lets Claude configure and drive it for you.

## Install

```bash
npm install -g @answerlayer/cli
```

Or run it without installing:

```bash
npx -y @answerlayer/cli --help
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

Create an API key in AnswerLayer with the scopes needed by your workflow, then run:

```bash
answerlayer configure --api-key al_live_...
```

The CLI talks to the hosted SaaS at `https://app.answerlayer.io` by default. For a
BYOC or self-hosted install, point it at your own URL:

```bash
answerlayer configure --api-key al_live_... --base-url https://answerlayer.your-company.com
```

You can also skip the config file and use environment variables:

```bash
export ANSWERLAYER_API_KEY=al_live_...
export ANSWERLAYER_BASE_URL=https://answerlayer.your-company.com  # optional override
```

The CLI sends API keys using the `X-API-Key` header.

Useful scopes:

- `api_key:manage` for API key management
- `connection:read` for listing connections
- `query:execute` for raw SQL
- `saved_query:read`, `saved_query:execute`, and `saved_query:write` for saved-query workflows
- `semantic:read`, `semantic:write`, and `semantic:generate` for semantic-layer workflows
- `dashboard:read`, `dashboard:write`, `tile:read`, and `tile:write` for dashboard workflows
- `inquiry:execute` for natural-language inquiry

## Commands

```bash
answerlayer health
answerlayer openapi --output openapi.json

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
- Data products: `saved-queries`, `semantic`, `inquiry`, `generation`, `tiles`, `dashboards`
- Supporting resources: `documents`, `branding`, `uploads`, `chains`, `users`, `org`, `roles`, `billing`, `stats`

## Development

```bash
npm test
```

The package intentionally has no runtime dependencies. It requires Node.js 20 or newer for built-in `fetch`.

## Related projects

- [`answerlayer-go`](https://github.com/AnswerLayer/answerlayer-go) — Go client/SDK for the Inquiry API.

## License

[Apache 2.0](LICENSE)
