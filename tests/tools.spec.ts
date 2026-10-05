import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AirtableClient } from '../src/client.ts'
import { createTools } from '../src/index.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const clientForTest = () => new AirtableClient({ token: process.env.AIRTABLE_TEST_TOKEN ?? `pat-test-${randomUUID()}` })

describe('dsh-tool-airtable tools', () => {
  it('registers the Airtable tool set', () => {
    expect(createTools(clientForTest()).map(tool => tool.name)).toEqual([
      'airtable_verify_token',
      'airtable_list_bases',
      'airtable_list_records',
      'airtable_get_record',
      'airtable_create_records',
      'airtable_update_record',
      'airtable_delete_record',
    ])
  })

  it('renders bases, records, and write results', () => {
    const tools = createTools(clientForTest())
    const bases = tools.find(item => item.name === 'airtable_list_bases')!
    const basesView = bases.output.render({}, {
      found: true,
      bases: [{ id: 'appDemoBase123456', name: 'CRM', permissionLevel: 'edit' }],
      offset: '',
    }) as Array<{ text: string }>
    expect(basesView[0].text).toContain('appDemoBase123456 CRM (edit)')

    const records = tools.find(item => item.name === 'airtable_list_records')!
    const recordsView = records.output.render({}, {
      found: true,
      records: [{ id: 'recDemoRecord0001', createdTime: '2026-10-05', fields: [{ name: 'Name', value: 'alice' }] }],
      offset: 'itrNext',
      truncated: false,
    }) as Array<{ text: string }>
    expect(recordsView[0].text).toContain('recDemoRecord0001 created=2026-10-05')
    expect(recordsView[0].text).toContain('Name=alice')
    expect(recordsView[0].text).toContain('offset=itrNext')

    const create = tools.find(item => item.name === 'airtable_create_records')!
    const appliedView = create.output.render({}, { ok: true, applied: true, baseId: 'appDemoBase123456', table: 'Tasks', detail: 'created=2' }) as Array<{ text: string }>
    expect(appliedView[0].text).toContain('Applied on appDemoBase123456/Tasks: created=2')
    const failureView = create.output.render({}, { ok: false, reason: 'recordsJson is not valid JSON.' }) as Array<{ text: string }>
    expect(failureView[0].text).toContain('Airtable write failed')
  })

  it('marks create, update, and delete as edits and keeps reads read-only', () => {
    const tools = createTools(clientForTest())
    for (const [name, args] of Object.entries({
      airtable_create_records: { baseId: 'appDemoBase123456', table: 'Tasks', recordsJson: '[]' },
      airtable_update_record: { baseId: 'appDemoBase123456', table: 'Tasks', recordId: 'recDemoRecord0001', fieldsJson: '{}' },
      airtable_delete_record: { baseId: 'appDemoBase123456', table: 'Tasks', recordId: 'recDemoRecord0001' },
    })) {
      const tool = tools.find(item => item.name === name)!
      expect(tool.presentCall(args)).toMatchObject({ kind: 'edit' })
    }
    expect(tools.find(item => item.name === 'airtable_verify_token')!.presentCall({})).toMatchObject({ kind: 'read' })
    expect(tools.find(item => item.name === 'airtable_list_records')!.presentCall({ baseId: 'appDemoBase123456', table: 'Tasks' })).toMatchObject({ kind: 'search' })
    expect(tools.find(item => item.name === 'airtable_get_record')!.presentCall({ baseId: 'appDemoBase123456', table: 'Tasks', recordId: 'recDemoRecord0001' })).toMatchObject({ kind: 'read' })
  })

  it('executes list and create through the tool layer without echoing values', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ records: [{ id: 'recDemoRecord0001', createdTime: '2026-10-05T00:00:00.000Z', fields: { Name: 'alice' } }], offset: '' }))
      .mockResolvedValueOnce(jsonResponse({ records: [{ id: 'recDemoRecord0002', createdTime: '2026-10-05T01:00:00.000Z', fields: { Name: 'secret-create-value' } }] }))
    const tools = createTools(new AirtableClient({ token: `pat-test-${randomUUID()}`, fetchImpl }))

    const list = tools.find(item => item.name === 'airtable_list_records')!
    const listResult = await list.execute({ baseId: 'appDemoBase123456', table: 'Tasks' })
    expect(listResult).toMatchObject({ found: true, records: [{ id: 'recDemoRecord0001' }] })

    const create = tools.find(item => item.name === 'airtable_create_records')!
    const createResult = await create.execute({ baseId: 'appDemoBase123456', table: 'Tasks', recordsJson: '[{"fields":{"Name":"secret-create-value"}}]' })
    expect(createResult).toMatchObject({ ok: true, applied: true, detail: 'created=1' })
    expect(JSON.stringify(createResult)).not.toContain('secret-create-value')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
