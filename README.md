# dsh-tool-airtable

[English](README.md) | [中文](README.zh.md)

Airtable base integration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a Cordis plugin. The agent can verify the token, list bases, query records with capped pages, and perform explicit single-purpose record create/update/delete — while the token and bulky cell values stay out of tool output.

## Install

```sh
npm install @libai168/dsh-tool-airtable
```

Requires `@deepseek-ai/cordis` (^4.0.1) and `@deepseek-ai/dsh-tools` (^0.1.0-rc.6) as peer dependencies.

## Configuration

```yaml
- name: 'github:LJH-snow/dsh-tool-airtable'
  config:
    # baseUrl: 'https://api.airtable.com/v0'
    tokenEnv: 'AIRTABLE_TOKEN'
    # timeoutMs: 15000
```

The plugin reads the Airtable personal access token from the environment variable named by `tokenEnv` (default: `AIRTABLE_TOKEN`). Do not put a usable token in source, examples, tests, or committed configuration. Create the token in the Airtable developer hub with only the base scopes your deployment needs (`data.records:read` plus `data.records:write` for the write tools, `schema.bases:read` for base listing).

## Tools

| Tool | Description | Write |
|---|---|---|
| `airtable_verify_token` | Verify the token via `meta/whoami` without returning it | No |
| `airtable_list_bases` | List accessible bases with offset pagination | No |
| `airtable_list_records` | List records with `pageSize`/`maxRecords`/`offset` and optional `filterByFormula` | No |
| `airtable_get_record` | Read one record with flattened field previews | No |
| `airtable_create_records` | Create up to 10 records from a JSON array | Yes |
| `airtable_update_record` | Update one record via PATCH | Yes |
| `airtable_delete_record` | Delete one record by ID | Yes |

## Security contract

- The token is read from an environment variable at plugin startup and is never included in tool output or rendered text.
- Base and record IDs are validated against the official `app…`/`rec…` 17-character formats, and every path segment is URL-encoded; table identifiers are length-capped.
- Record pages are capped at 50 per request (200 across `maxRecords`), with a 20,000-character response budget flagged via `truncated`; cell values are flattened to 300-character previews (arrays, linked records, and attachments included) and empty fields are dropped.
- `airtable_create_records` enforces the API batch limit of 10 records per call and never echoes cell values back — results carry only counts and IDs; the update tool requires a non-empty fields object.
- All three write tools are explicit-parameter operations marked `kind: 'edit'`; there are no schema-mutation, base-creation, or bulk-delete tools.
- The client passes caller cancellation signals through to `fetch` and uses a 15-second timeout by default.
- API failures are normalized into `{ ok: false, reason }` or `{ found: false, reason }` tool results.

## API scope

This version uses the Airtable Web API endpoints documented at developers.airtable.com: `GET /v0/meta/whoami`, `GET /v0/meta/bases`, and the records collection endpoints (`GET`, `POST` with a `records` array, single-record `PATCH`/`DELETE`). Table-schema listing, comments, webhooks, and base/ table creation are intentionally not included.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Tests run fully offline against an injected fetch; no Airtable account is needed.

## License

[MIT](LICENSE)
