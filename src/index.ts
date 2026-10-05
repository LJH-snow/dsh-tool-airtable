import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AirtableClient, AirtableError } from './client.js'

export const name = 'dsh-tool-airtable'
export const inject = ['tools']

export interface AirtablePluginConfig {
  baseUrl?: string
  /** Environment variable containing the Airtable personal access token. */
  tokenEnv?: string
  timeoutMs?: number
}

export function apply(ctx: Context, config: AirtablePluginConfig = {}) {
  const tokenEnv = config.tokenEnv ?? 'AIRTABLE_TOKEN'
  const client = new AirtableClient({
    baseUrl: config.baseUrl,
    token: process.env[tokenEnv],
    timeoutMs: config.timeoutMs,
  })
  for (const tool of createTools(client)) ctx.tools.register(tool)
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function unavailable(reason: string) {
  return { found: false, records: [], bases: [], reason }
}

function errorReason(error: unknown): string {
  return error instanceof AirtableError ? error.message : error instanceof Error ? error.message : String(error)
}

const LIST_RENDER_LIMIT = 10

function renderToken(value: { ok?: boolean; reason?: string; userId?: string; email?: string }) {
  return value.ok
    ? text(`Airtable authenticated as ${value.email || value.userId || ''}`)
    : text(`Airtable authentication failed: ${value.reason ?? ''}`)
}

function renderBases(items: Array<{ id?: string; name?: string; permissionLevel?: string }>) {
  if (!items.length) return text('No Airtable bases found.')
  return text(items.map(base => `${base.id ?? ''} ${base.name ?? ''} (${base.permissionLevel ?? ''})`).join('\n'))
}

function renderRecord(record: { id?: string; createdTime?: string; fields?: Array<{ name?: string; value?: string }> }): string {
  const fields = (record.fields ?? []).map(field => `${field.name ?? ''}=${field.value ?? ''}`).join(' | ')
  return `${record.id ?? ''} created=${record.createdTime ?? ''}${fields ? `\n  ${fields}` : ''}`
}

function renderRecords(value: { found?: boolean; reason?: string; records?: Array<{ id?: string; createdTime?: string; fields?: Array<{ name?: string; value?: string }> }>; offset?: string; truncated?: boolean }) {
  if (!value.found) return text(value.reason ?? 'Airtable records unavailable.')
  const records = value.records ?? []
  if (!records.length) return text('No records matched.')
  const lines = records.slice(0, LIST_RENDER_LIMIT).map(renderRecord)
  if (records.length > LIST_RENDER_LIMIT) lines.push(`... ${records.length - LIST_RENDER_LIMIT} more records omitted`)
  if (value.truncated) lines.push('[result set truncated by size budget]')
  if (value.offset) lines.push(`offset=${value.offset}`)
  return text(lines.join('\n'))
}

function renderWrite(value: { ok?: boolean; reason?: string; applied?: boolean; baseId?: string; table?: string; detail?: string }) {
  if (!value.ok) return text(`Airtable write failed: ${value.reason ?? ''}`)
  return value.applied
    ? text(`Applied on ${value.baseId ?? ''}/${value.table ?? ''}: ${value.detail ?? ''}`)
    : text(`Not applied on ${value.baseId ?? ''}/${value.table ?? ''}`)
}

export function createTools(client: AirtableClient) {
  return [
    defineTool({
      name: 'airtable_verify_token',
      description: 'Verify the configured Airtable personal access token without returning it.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, userId: { type: 'string' }, email: { type: 'string' } } },
        render: (_args, value) => renderToken(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Verify Airtable credentials', kind: 'read' } },
      async execute(_args, exec) {
        if (!client.hasToken()) return { ok: false, reason: 'Airtable token is not configured.' }
        try { return { ok: true, ...await client.verifyToken(exec?.signal) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'airtable_list_bases',
      description: 'List Airtable bases the token can access (capped at 50, offset pagination).',
      parameters: { offset: { type: 'string', description: 'Offset from a previous response' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, bases: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, permissionLevel: { type: 'string' } } } }, offset: { type: 'string' } } },
        render: (_args, value) => !value.found ? text(value.reason ?? 'Airtable bases unavailable.') : renderBases(value.bases ?? []),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Airtable bases', kind: 'search' } },
      async execute(args, exec) {
        if (!client.hasToken()) return unavailable('Airtable token is not configured.')
        try { return { found: true, ...await client.listBases({ offset: args.offset as string, signal: exec?.signal }) } }
        catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'airtable_list_records',
      description: 'List records in one table with capped page size and an optional filter formula. Field values are flattened previews.',
      parameters: {
        baseId: { type: 'string', required: true, description: 'Base ID, e.g. appXXXXXXXXXXXXXX' },
        table: { type: 'string', required: true, description: 'Table name or table ID' },
        pageSize: { type: 'integer', description: 'Records per page, 1-50 (default 20)' },
        maxRecords: { type: 'integer', description: 'Cap on total records across pages, 1-200' },
        offset: { type: 'string', description: 'Offset from a previous response' },
        formula: { type: 'string', description: 'filterByFormula expression, max 2000 characters' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, records: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, createdTime: { type: 'string' }, fields: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, value: { type: 'string' } } } } } } }, offset: { type: 'string' }, truncated: { type: 'boolean' } } },
        render: (_args, value) => renderRecords(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Airtable records ${args.table ?? ''}`, kind: 'search' } },
      async execute(args, exec) {
        if (!client.hasToken()) return unavailable('Airtable token is not configured.')
        if (!args.baseId || !args.table) return unavailable('baseId and table are required.')
        try {
          return { found: true, ...await client.listRecords(args.baseId as string, args.table as string, {
            pageSize: args.pageSize as number,
            maxRecords: args.maxRecords as number,
            offset: args.offset as string,
            formula: args.formula as string,
            signal: exec?.signal,
          }) }
        } catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'airtable_get_record',
      description: 'Read one record with flattened field previews.',
      parameters: {
        baseId: { type: 'string', required: true, description: 'Base ID' },
        table: { type: 'string', required: true, description: 'Table name or table ID' },
        recordId: { type: 'string', required: true, description: 'Record ID, e.g. recXXXXXXXXXXXXXX' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, id: { type: 'string' }, createdTime: { type: 'string' }, fields: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, value: { type: 'string' } } } } } },
        render: (_args, value) => !value.found ? text(value.reason ?? 'Airtable record not found.') : text(renderRecord(value)),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Airtable record ${args.recordId ?? ''}`, kind: 'read' } },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, reason: 'Airtable token is not configured.' }
        if (!args.baseId || !args.table || !args.recordId) return { found: false, reason: 'baseId, table, and recordId are required.' }
        try { return { found: true, ...await client.getRecord(args.baseId as string, args.table as string, args.recordId as string, exec?.signal) } }
        catch (error) { return { found: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'airtable_create_records',
      description: 'Create up to 10 records from a JSON array of {fields}. WRITE operation; cell values are never echoed back.',
      parameters: {
        baseId: { type: 'string', required: true, description: 'Base ID' },
        table: { type: 'string', required: true, description: 'Table name or table ID' },
        recordsJson: { type: 'string', required: true, description: 'JSON array like [{"fields":{"Name":"..."}}], max 10 records' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, applied: { type: 'boolean' }, baseId: { type: 'string' }, table: { type: 'string' }, detail: { type: 'string' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Create records in ${args.table ?? ''}`, kind: 'edit' } },
      async execute(args, exec) {
        if (!client.hasToken()) return { ok: false, reason: 'Airtable token is not configured.' }
        if (!args.baseId || !args.table || !args.recordsJson) return { ok: false, reason: 'baseId, table, and recordsJson are required.' }
        try { return await client.createRecords(args.baseId as string, args.table as string, args.recordsJson as string, exec?.signal) }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'airtable_update_record',
      description: 'Update one record via PATCH with a JSON fields object. WRITE operation.',
      parameters: {
        baseId: { type: 'string', required: true, description: 'Base ID' },
        table: { type: 'string', required: true, description: 'Table name or table ID' },
        recordId: { type: 'string', required: true, description: 'Record ID to update' },
        fieldsJson: { type: 'string', required: true, description: 'JSON object of fields to set' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, applied: { type: 'boolean' }, baseId: { type: 'string' }, table: { type: 'string' }, detail: { type: 'string' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Update ${args.recordId ?? ''}`, kind: 'edit' } },
      async execute(args, exec) {
        if (!client.hasToken()) return { ok: false, reason: 'Airtable token is not configured.' }
        if (!args.baseId || !args.table || !args.recordId || !args.fieldsJson) return { ok: false, reason: 'baseId, table, recordId, and fieldsJson are required.' }
        try { return await client.updateRecord(args.baseId as string, args.table as string, args.recordId as string, args.fieldsJson as string, exec?.signal) }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'airtable_delete_record',
      description: 'Delete one record by ID. WRITE operation; single record only.',
      parameters: {
        baseId: { type: 'string', required: true, description: 'Base ID' },
        table: { type: 'string', required: true, description: 'Table name or table ID' },
        recordId: { type: 'string', required: true, description: 'Record ID to delete' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, applied: { type: 'boolean' }, baseId: { type: 'string' }, table: { type: 'string' }, detail: { type: 'string' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Delete ${args.recordId ?? ''}`, kind: 'edit' } },
      async execute(args, exec) {
        if (!client.hasToken()) return { ok: false, reason: 'Airtable token is not configured.' }
        if (!args.baseId || !args.table || !args.recordId) return { ok: false, reason: 'baseId, table, and recordId are required.' }
        try { return await client.deleteRecord(args.baseId as string, args.table as string, args.recordId as string, exec?.signal) }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),
  ]
}
