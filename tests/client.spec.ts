import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AirtableClient, AirtableError } from '../src/client.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const testToken = process.env.AIRTABLE_TEST_TOKEN ?? `pat-test-${randomUUID()}`

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return new AirtableClient({ baseUrl: 'https://airtable.test.invalid/v0', token: testToken, fetchImpl })
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
    await expect(new AirtableClient({ fetchImpl }).verifyToken()).rejects.toThrow(AirtableError)
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
