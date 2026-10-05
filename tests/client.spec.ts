import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AirtableClient, AirtableError } from '../src/client.ts'

/** Deterministic DNS so tests never depend on real resolution. */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }]


function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const testToken = process.env.AIRTABLE_TEST_TOKEN ?? `pat-test-${randomUUID()}`

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return new AirtableClient({ lookupImpl: publicLookup, baseUrl: 'https://airtable.test.invalid/v0', token: testToken, fetchImpl })
}

describe('AirtableClient', () => {
  it('sends the bearer token and maps whoami without exposing the token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'usrDemo1', email: 'alice@example.invalid' }))
    const result = await client(fetchImpl).verifyToken()

    expect(result).toEqual({ userId: 'usrDemo1', email: 'alice@example.invalid' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://airtable.test.invalid/v0/meta/whoami')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${testToken}`)
    expect(JSON.stringify(result)).not.toContain(testToken)
  })

  it('lists bases with offset pagination and validates ids', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ bases: [{ id: 'appDemoBase123456', name: 'CRM', permissionLevel: 'edit' }], offset: 'next-offset' }))
    const result = await client(fetchImpl).listBases({ offset: 'itr-prev' })

    expect(result.bases).toEqual([{ id: 'appDemoBase123456', name: 'CRM', permissionLevel: 'edit' }])
    expect(result.offset).toBe('next-offset')
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://airtable.test.invalid/v0/meta/bases?offset=itr-prev')
  })

  it('lists records with clamped page size, formula, and offset pagination', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      records: [
        { id: 'recDemoRecord0001', createdTime: '2026-10-05T00:00:00.000Z', fields: { Name: 'alice', Tags: ['a', 'b', 'c'], Link: { url: 'https://example.invalid/x' }, Empty: '' } },
        { id: 'recDemoRecord0002', createdTime: '2026-10-05T01:00:00.000Z', fields: {} },
      ],
      offset: 'itrNext/recDemoRecord0002',
    }))
    const result = await client(fetchImpl).listRecords('appDemoBase123456', 'Tasks', { pageSize: 500, maxRecords: 10, formula: 'NOT({Done})' })

    expect(result.records[0].id).toBe('recDemoRecord0001')
    const fields = result.records[0].fields
    expect(fields).toEqual([
      { name: 'Name', value: 'alice' },
      { name: 'Tags', value: '[a, b, c]' },
      { name: 'Link', value: 'https://example.invalid/x' },
    ])
    expect(result.records[1].fields).toEqual([])
    expect(result.offset).toBe('itrNext/recDemoRecord0002')
    expect(result.truncated).toBe(false)
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://airtable.test.invalid/v0/appDemoBase123456/Tasks?pageSize=50&maxRecords=10&filterByFormula=NOT%28%7BDone%7D%29')
  })

  it('flags truncated results when the size budget is exceeded', async () => {
    const bigFields = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Field${index}`, 'x'.repeat(900)]))
    const fetchImpl = vi.fn(async () => jsonResponse({
      records: Array.from({ length: 50 }, (_, index) => ({ id: `recDemoRecord000${index % 10}`, createdTime: '', fields: bigFields })),
    }))
    const result = await client(fetchImpl).listRecords('appDemoBase123456', 'Tasks', { pageSize: 50 })

    expect(result.truncated).toBe(true)
    expect(result.records.length).toBeGreaterThan(1)
    expect(result.records.length).toBeLessThan(50)
    const total = result.records.reduce((sum, item) => sum + JSON.stringify(item).length, 0)
    expect(total).toBeLessThanOrEqual(20000)
  })

  it('validates ids and clamps table length', async () => {
    const fetchImpl = vi.fn()
    const fire = client(fetchImpl)
    await expect(fire.listRecords('bad-id', 'Tasks')).rejects.toThrow('baseId must look like app')
    await expect(fire.getRecord('appDemoBase123456', 'Tasks', 'wrong-record-id')).rejects.toThrow('recordId must look like rec')
    await expect(fire.listRecords('appDemoBase123456', `${'t'.repeat(300)}`)).rejects.toThrow('table must be a non-empty')
    await expect(new AirtableClient({ lookupImpl: publicLookup, fetchImpl }).verifyToken()).rejects.toThrow(AirtableError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('creates records with the records payload and never echoes cell values', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ records: [{ id: 'recDemoRecord0009', createdTime: '2026-10-05T02:00:00.000Z', fields: { Name: 'secret-row-42' } }] }))
    const result = await client(fetchImpl).createRecords('appDemoBase123456', 'Tasks', '[{"fields":{"Name":"secret-row-42"}}]')

    expect(result).toEqual({ ok: true, applied: true, baseId: 'appDemoBase123456', table: 'Tasks', detail: 'created=1' })
    expect(JSON.stringify(result)).not.toContain('secret-row-42')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://airtable.test.invalid/v0/appDemoBase123456/Tasks')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ records: [{ fields: { Name: 'secret-row-42' } }] })
    await expect(client(fetchImpl).createRecords('appDemoBase123456', 'Tasks', JSON.stringify(Array.from({ length: 11 }, () => ({ fields: { A: 1 } }))))).rejects.toThrow('at most 10 records')
    await expect(client(fetchImpl).createRecords('appDemoBase123456', 'Tasks', 'not-json')).rejects.toThrow('not valid JSON')
  })

  it('updates one record via PATCH and deletes via DELETE', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'recDemoRecord0001', createdTime: '', fields: { Done: true } }))
      .mockResolvedValueOnce(jsonResponse({ id: 'recDemoRecord0001', deleted: true }))
    const fire = client(fetchImpl)
    const updated = await fire.updateRecord('appDemoBase123456', 'Tasks', 'recDemoRecord0001', '{"Done":true}')
    const removed = await fire.deleteRecord('appDemoBase123456', 'Tasks', 'recDemoRecord0001')

    expect(updated).toMatchObject({ ok: true, applied: true, detail: 'updated=recDemoRecord0001 fields=1' })
    expect(removed).toEqual({ ok: true, applied: true, baseId: 'appDemoBase123456', table: 'Tasks', detail: 'deleted=recDemoRecord0001' })
    const [patchUrl, patchInit] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const [deleteUrl, deleteInit] = fetchImpl.mock.calls[1] as [string, RequestInit]
    expect(patchUrl).toBe('https://airtable.test.invalid/v0/appDemoBase123456/Tasks/recDemoRecord0001')
    expect(patchInit.method).toBe('PATCH')
    expect(deleteUrl).toBe(patchUrl)
    expect(deleteInit.method).toBe('DELETE')
    await expect(fire.updateRecord('appDemoBase123456', 'Tasks', 'recDemoRecord0001', '{}')).rejects.toThrow('at least one field')
  })

  it('maps Airtable error payloads into AirtableError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { type: 'TABLE_NOT_FOUND', message: 'Could not find table Tasks' } }, 404))
    await expect(client(fetchImpl).getRecord('appDemoBase123456', 'Tasks', 'recDemoRecord0001')).rejects.toThrow('Could not find table Tasks')
    await expect(client(fetchImpl).getRecord('appDemoBase123456', 'Tasks', 'recDemoRecord0001')).rejects.toBeInstanceOf(AirtableError)
  })
})

describe('Airtable endpoint security', () => {
  const valid = { token: 'pat_test' }

  it('rejects invalid base URLs without exposing their contents', () => {
    for (const baseUrl of [
      'api.airtable.com/v0',
      'ftp://api.airtable.com/v0',
      'https://user:secret@api.airtable.com/v0',
      'https://api.airtable.com/v0?token=secret',
      'https://api.airtable.com/v0#fragment',
    ]) {
      let error: unknown
      try { new AirtableClient({ ...valid, baseUrl }) } catch (thrown) { error = thrown }
      expect(error).toBeInstanceOf(AirtableError)
      expect(String(error)).not.toContain('secret')
    }
  })

  it('rejects literal local, private, and reserved addresses before fetch', async () => {
    for (const baseUrl of [
      'http://localhost',
      'http://service.localhost',
      'http://service.local',
      'http://127.0.0.1',
      'http://169.254.169.254',
      'http://0.0.0.0',
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://192.0.2.1',
      'http://198.18.0.1',
      'http://224.0.0.1',
      'http://192.175.48.1',
      'http://[::1]',
      'http://[::]',
      'http://[fc00::1]',
      'http://[fe80::1]',
      'http://[fec0::1]',
      'http://[2001:db8::1]',
      'http://[2001:3::1]',
      'http://[2001:4:112::1]',
      'http://[2001:30::1]',
      'http://[5f00::1]',
      'http://[100:0:0:1::1]',
      'http://[2620:4f:8000::1]',
      'http://[64:ff9b::7f00:1]',
      'http://[ff02::1]',
    ]) {
      const fetchImpl = vi.fn()
      await expect(new AirtableClient({ ...valid, baseUrl, fetchImpl }).verifyToken()).rejects.toBeInstanceOf(AirtableError)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('fails closed on blocked, failed, empty, or inconsistent DNS results', async () => {
    for (const lookupImpl of [
      async () => [{ address: '192.168.1.10', family: 4 as const }],
      async () => [{ address: '93.184.216.34', family: 4 as const }, { address: '169.254.169.254', family: 4 as const }],
      async () => { throw new Error('dns failure') },
      async () => [],
      async () => [{ address: '2001:db8::1', family: 4 as const }],
    ]) {
      const fetchImpl = vi.fn()
      await expect(new AirtableClient({ ...valid, baseUrl: 'https://airtable.example.test', fetchImpl, lookupImpl }).verifyToken()).rejects.toBeInstanceOf(AirtableError)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('allows a public endpoint that resolves to a public address', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    await new AirtableClient({ ...valid, baseUrl: 'https://airtable.example.test', fetchImpl, lookupImpl: publicLookup }).verifyToken().catch(() => undefined)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
