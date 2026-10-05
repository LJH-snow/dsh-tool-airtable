/** Airtable Web API client with injected fetch for testability. Contract verified
 * against the official developer docs (list/create records, whoami, meta bases). */

export interface AirtableClientOptions {
  /** Airtable API root, for example https://api.airtable.com/v0. */
  baseUrl?: string
  /** Airtable personal access token. Prefer supplying it from a secret-backed config. */
  token?: string
  /** HTTP request timeout in milliseconds. 0 disables the timeout. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class AirtableError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'AirtableError'
  }
}

export interface AirtableUserInfo {
  userId: string
  email: string
}

export interface AirtableBaseInfo {
  id: string
  name: string
  permissionLevel: string
}

export interface AirtableRecordInfo {
  id: string
  createdTime: string
  fields: Array<{ name: string; value: string }>
}

export interface AirtableRecordsResult {
  records: AirtableRecordInfo[]
  offset: string
  truncated: boolean
}

export interface AirtableWriteResult {
  ok: boolean
  applied: boolean
  baseId: string
  table: string
  detail: string
}

const FIELD_VALUE_LIMIT = 300
const FIELD_RENDER_LIMIT = 15
const RECORDS_PAGE_LIMIT = 50
const RECORDS_TOTAL_LIMIT = 200
const RESULT_TOTAL_LIMIT = 20000
const FORMULA_LIMIT = 2000
const RECORDS_PER_CREATE = 10
const OFFSET_LIMIT = 500
const NAME_LIMIT = 200

const BASE_ID_PATTERN = /^app[A-Za-z0-9]{14}$/
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9]{14}$/

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : value == null ? '' : ''
}

function clampText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

/** Cell values can be nested arrays or objects (linked records, attachments);
 * flatten them into bounded, readable strings. */
function serializeFieldValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return clampText(value, FIELD_VALUE_LIMIT)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const items = value.slice(0, 5).map(item => serializeFieldValue(item)).filter(Boolean)
    const suffix = value.length > 5 ? ` ...(+${value.length - 5})` : ''
    return `[${items.join(', ')}]${suffix}`
  }
  const record = asRecord(value)
  const url = asString(record.url)
  const name = asString(record.name) || asString(record.filename)
  const id = asString(record.id)
  return clampText(url || name || id || '<object>', FIELD_VALUE_LIMIT)
}

function mapFields(fields: unknown): Array<{ name: string; value: string }> {
  return Object.entries(asRecord(fields))
    .map(([name, value]) => ({ name: clampText(name, NAME_LIMIT), value: serializeFieldValue(value) }))
    .filter(field => field.value !== '')
    .slice(0, FIELD_RENDER_LIMIT)
}

function mapRecord(value: unknown): AirtableRecordInfo {
  const record = asRecord(value)
  return {
    id: asString(record.id),
    createdTime: asString(record.createdTime),
    fields: mapFields(record.fields),
  }
}

export class AirtableClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: AirtableClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.airtable.com/v0').replace(/\/+$/, '')
    this.token = options.token ?? ''
    this.timeoutMs = options.timeoutMs ?? 15000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  hasToken(): boolean {
    return Boolean(this.token)
  }

  private validateBaseId(baseId: string): void {
    if (!BASE_ID_PATTERN.test(baseId)) throw new AirtableError('baseId must look like appXXXXXXXXXXXXXX.', 400)
  }

  private validateRecordId(recordId: string): void {
    if (!RECORD_ID_PATTERN.test(recordId)) throw new AirtableError('recordId must look like recXXXXXXXXXXXXXX.', 400)
  }

  private validateTable(table: string): void {
    if (!table.trim() || table.length > NAME_LIMIT) throw new AirtableError('table must be a non-empty table name or ID.', 400)
  }

  private parseRecordsPayload(raw: unknown): Array<{ fields: Record<string, unknown> }> {
    if (typeof raw !== 'string' || !raw.trim()) throw new AirtableError('recordsJson is required and must be a JSON array of {fields} objects.', 400)
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      throw new AirtableError('recordsJson is not valid JSON.', 400)
    }
    if (!Array.isArray(parsed) || !parsed.length) throw new AirtableError('recordsJson must be a non-empty JSON array.', 400)
    if (parsed.length > RECORDS_PER_CREATE) throw new AirtableError(`recordsJson allows at most ${RECORDS_PER_CREATE} records per call.`, 400)
    return parsed.map(item => {
      const record = asRecord(item)
      const fields = asRecord(record.fields)
      if (!Object.keys(fields).length) throw new AirtableError('each record must carry a non-empty fields object.', 400)
      return { fields }
    })
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    options: { params?: Record<string, string | number | undefined>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!this.hasToken()) throw new AirtableError('Airtable token not configured.', 401)
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${this.token}` }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const controller = new AbortController()
    const combined = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const timer = this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined
    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: combined,
      })
      const raw = await response.text()
      let json: unknown = {}
      if (raw) {
        try { json = JSON.parse(raw) } catch { json = {} }
      }
      if (!response.ok) {
        const record = asRecord(json)
        const error = asRecord(record.error)
        const message = asString(error.message) || asString(record.message) || raw.slice(0, 300) || response.statusText
        throw new AirtableError(`Airtable API ${method} ${path} returned HTTP ${response.status}: ${message}`, response.status)
      }
      return json as T
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async verifyToken(signal?: AbortSignal): Promise<AirtableUserInfo> {
    const raw = await this.request('GET', '/meta/whoami', { signal })
    const record = asRecord(raw)
    return {
      userId: asString(record.id),
      email: asString(record.email),
    }
  }

  async listBases(options: { offset?: string; signal?: AbortSignal } = {}): Promise<{ bases: AirtableBaseInfo[]; offset: string }> {
    const offset = options.offset ? clampText(options.offset, OFFSET_LIMIT) : undefined
    const raw = await this.request('GET', '/meta/bases', { params: { offset }, signal: options.signal })
    const record = asRecord(raw)
    return {
      bases: asArray(record.bases)
        .map(base => {
          const item = asRecord(base)
          return {
            id: asString(item.id),
            name: clampText(asString(item.name), NAME_LIMIT),
            permissionLevel: asString(item.permissionLevel),
          }
        })
        .filter(base => BASE_ID_PATTERN.test(base.id))
        .slice(0, RECORDS_PAGE_LIMIT),
      offset: clampText(asString(record.offset), OFFSET_LIMIT),
    }
  }

  async listRecords(
    baseId: string,
    table: string,
    options: { pageSize?: number; maxRecords?: number; offset?: string; formula?: string; signal?: AbortSignal } = {},
  ): Promise<AirtableRecordsResult> {
    this.validateBaseId(baseId)
    this.validateTable(table)
    const formula = options.formula ? clampText(options.formula, FORMULA_LIMIT) : undefined
    const raw = await this.request('GET', `/${encode(baseId)}/${encode(table)}`, {
      params: {
        pageSize: clampInt(options.pageSize, 1, RECORDS_PAGE_LIMIT),
        maxRecords: clampInt(options.maxRecords, 1, RECORDS_TOTAL_LIMIT),
        offset: options.offset ? clampText(options.offset, OFFSET_LIMIT) : undefined,
        filterByFormula: formula,
      },
      signal: options.signal,
    })
    const record = asRecord(raw)
    const records = asArray(record.records).map(mapRecord).slice(0, RECORDS_PAGE_LIMIT)
    let totalBytes = 0
    let truncated = false
    const kept: AirtableRecordInfo[] = []
    for (const item of records) {
      const size = JSON.stringify(item).length
      if (totalBytes + size > RESULT_TOTAL_LIMIT) {
        truncated = true
        break
      }
      totalBytes += size
      kept.push(item)
    }
    return { records: kept, offset: clampText(asString(record.offset), OFFSET_LIMIT), truncated }
  }

  async getRecord(baseId: string, table: string, recordId: string, signal?: AbortSignal): Promise<AirtableRecordInfo> {
    this.validateBaseId(baseId)
    this.validateTable(table)
    this.validateRecordId(recordId)
    const raw = await this.request('GET', `/${encode(baseId)}/${encode(table)}/${encode(recordId)}`, { signal })
    return mapRecord(raw)
  }

  async createRecords(baseId: string, table: string, recordsJson: string, signal?: AbortSignal): Promise<AirtableWriteResult> {
    this.validateBaseId(baseId)
    this.validateTable(table)
    const records = this.parseRecordsPayload(recordsJson)
    await this.request('POST', `/${encode(baseId)}/${encode(table)}`, { body: { records }, signal })
    return { ok: true, applied: true, baseId, table, detail: `created=${records.length}` }
  }

  async updateRecord(baseId: string, table: string, recordId: string, fieldsJson: string, signal?: AbortSignal): Promise<AirtableWriteResult> {
    this.validateBaseId(baseId)
    this.validateTable(table)
    this.validateRecordId(recordId)
    if (typeof fieldsJson !== 'string' || !fieldsJson.trim()) throw new AirtableError('fieldsJson is required and must be a JSON object.', 400)
    let fields: unknown
    try { fields = JSON.parse(fieldsJson) } catch {
      throw new AirtableError('fieldsJson is not valid JSON.', 400)
    }
    const fieldsRecord = asRecord(fields)
    if (!Object.keys(fieldsRecord).length) throw new AirtableError('fieldsJson must contain at least one field.', 400)
    await this.request('PATCH', `/${encode(baseId)}/${encode(table)}/${encode(recordId)}`, { body: { fields: fieldsRecord }, signal })
    return { ok: true, applied: true, baseId, table, detail: `updated=${recordId} fields=${Object.keys(fieldsRecord).length}` }
  }

  async deleteRecord(baseId: string, table: string, recordId: string, signal?: AbortSignal): Promise<AirtableWriteResult> {
    this.validateBaseId(baseId)
    this.validateTable(table)
    this.validateRecordId(recordId)
    const raw = await this.request('DELETE', `/${encode(baseId)}/${encode(table)}/${encode(recordId)}`, { signal })
    const record = asRecord(raw)
    const deleted = record.deleted === true
    return { ok: true, applied: deleted, baseId, table, detail: `deleted=${recordId}` }
  }
}
