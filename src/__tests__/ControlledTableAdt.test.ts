import {
  type AdtHTTP,
  activateControlledTable,
  activateControlledTableSettings,
  buildControlledTableSettingsXml,
  buildControlledTableShellXml,
  createControlledTableShell,
  parseControlledTable,
  parseControlledTableSettings,
  readControlledTable,
  readControlledTableSettings,
  readControlledTableSource,
  runControlledTableCheck,
  validateControlledTableShell,
  writeControlledTableSettings,
  writeControlledTableSource
} from '../adt/index.js'

const shell = {
  name: 'ZZIF_MCP_TEST', description: 'MCP测试表', packageName: 'Z001', transportRequest: 'S4HK900009',
  language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
}

const source = `@EndUserText.label : 'MCP测试表'\ndefine table zzif_mcp_test {\n  key client : abap.clnt not null;\n}\n`

const tableResponse = `<?xml version="1.0" encoding="utf-8"?>
<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core" abapsource:sourceUri="./zzif_mcp_test/source/main" adtcore:name="ZZIF_MCP_TEST" adtcore:type="TABL/DT" adtcore:version="inactive" adtcore:description="MCP测试表">
  <adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/z001" adtcore:type="DEVC/K" adtcore:name="Z001"/>
</blue:blueSource>`

const settingsResponse = `<?xml version="1.0" encoding="utf-8"?>
<ts:tableSettings xmlns:ts="http://www.sap.com/dictionary/table/settings" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZIF_MCP_TEST" adtcore:type="TABL/DTT" adtcore:changedAt="2026-08-19T06:08:10Z" adtcore:version="active" adtcore:createdAt="2026-08-18T16:00:00Z" adtcore:changedBy="068157" adtcore:createdBy="068157" adtcore:description="MCP测试表" adtcore:language="ZH">
  <ts:dataClassCategory>APPL1</ts:dataClassCategory><ts:sizeCategory>0</ts:sizeCategory>
  <ts:buffering><ts:allowed>N</ts:allowed><ts:type/><ts:areaKeyFields>0</ts:areaKeyFields></ts:buffering>
  <ts:storageType>C</ts:storageType><ts:loggingEnabled>false</ts:loggingEnabled>
</ts:tableSettings>`

const validationResponse = '<asx:abap><asx:values><DATA><SEVERITY>S</SEVERITY><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>'
const checkResponse = '<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>'
const activationResponse = '<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><chkl:properties checkExecuted="true" activationExecuted="true"/></chkl:messages>'

function http(response: Partial<{ body: string; status: number; headers: Record<string, string> }> = {}) {
  return {
    request: jest.fn().mockResolvedValue({ body: '', status: 200, statusText: 'OK', headers: {}, ...response })
  } as unknown as AdtHTTP
}

describe('controlled database table ADT contract', () => {
  it('validates and creates the captured TABL/DT V2 shell', async () => {
    const validationClient = http({ body: validationResponse })
    await validateControlledTableShell(validationClient, shell)
    expect((validationClient.request as jest.Mock).mock.calls[0]).toEqual([
      '/sap/bc/adt/ddic/tables/validation', {
        method: 'POST', qs: { objtype: 'tabldt', objname: 'ZZIF_MCP_TEST', description: 'MCP测试表' }
      }
    ])

    const xml = buildControlledTableShellXml(shell)
    expect(xml).toContain('adtcore:type="TABL/DT"')
    expect(xml).toContain('adtcore:name="ZZIF_MCP_TEST"')
    expect(xml).toContain('<adtcore:packageRef adtcore:name="Z001"/>')
    const client = http({ body: tableResponse, status: 201, headers: { location: '/sap/bc/adt/ddic/tables/zzif_mcp_test' } })
    await expect(createControlledTableShell(client, shell)).resolves.toMatchObject({
      location: '/sap/bc/adt/ddic/tables/zzif_mcp_test',
      table: { name: 'ZZIF_MCP_TEST', packageName: 'Z001', version: 'inactive' }
    })
    expect((client.request as jest.Mock).mock.calls[0]).toEqual([
      '/sap/bc/adt/ddic/tables', expect.objectContaining({
        method: 'POST', qs: { corrNr: 'S4HK900009' },
        headers: {
          'Content-Type': 'application/vnd.sap.adt.tables.v2+xml',
          Accept: 'application/vnd.sap.adt.blues.v1+xml, application/vnd.sap.adt.tables.v2+xml'
        }
      })
    ])
  })

  it('requires HTTP 201, the canonical Location, and matching table identity', async () => {
    await expect(createControlledTableShell(http({ body: tableResponse, status: 201, headers: {} }), shell)).rejects.toThrow('Location')
    await expect(createControlledTableShell(http({ body: tableResponse, status: 201, headers: { location: '/sap/bc/adt/ddic/tables/zother' } }), shell)).rejects.toThrow('identity')
    await expect(createControlledTableShell(http({ body: tableResponse.replace(/ZZIF_MCP_TEST/g, 'ZOTHER'), status: 201, headers: { location: '/sap/bc/adt/ddic/tables/zzif_mcp_test' } }), shell)).rejects.toThrow('identity')
    expect(parseControlledTable(tableResponse)).toMatchObject({
      name: 'ZZIF_MCP_TEST', description: 'MCP测试表', packageName: 'Z001', sourceUri: './zzif_mcp_test/source/main'
    })
  })

  it('reads and writes source with only server-owned URLs and lock data', async () => {
    const client = http({ body: source })
    await readControlledTable(client, shell.name, 'inactive')
    await readControlledTableSource(client, shell.name, 'workingArea')
    await writeControlledTableSource(client, shell.name, source, 'LOCK-1', shell.transportRequest)
    expect((client.request as jest.Mock).mock.calls).toEqual([
      ['/sap/bc/adt/ddic/tables/zzif_mcp_test', expect.objectContaining({ qs: { version: 'inactive' } })],
      ['/sap/bc/adt/ddic/tables/zzif_mcp_test/source/main', { headers: { Accept: 'text/plain' }, qs: { version: 'workingArea' } }],
      ['/sap/bc/adt/ddic/tables/zzif_mcp_test/source/main', {
        method: 'PUT', qs: { lockHandle: 'LOCK-1', corrNr: 'S4HK900009' },
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain' }, body: source
      }]
    ])
  })

  it.each(['tableStatusCheck', 'abapCheckRun'] as const)('runs the %s reporter with the captured check contract', async reporter => {
    const client = http({ body: checkResponse })
    await expect(runControlledTableCheck(client, shell.name, reporter, source)).resolves.toEqual([])
    const [url, options] = (client.request as jest.Mock).mock.calls[0]
    expect(url).toBe('/sap/bc/adt/checkruns')
    expect(options).toMatchObject({
      method: 'POST', qs: { reporters: reporter },
      headers: {
        'Content-Type': 'application/vnd.sap.adt.checkobjects+xml',
        Accept: 'application/vnd.sap.adt.checkmessages+xml'
      }
    })
    expect(options.body).toContain('adtcore:uri="/sap/bc/adt/ddic/tables/zzif_mcp_test"')
    expect(options.body).toContain('chkrun:uri="/sap/bc/adt/ddic/tables/zzif_mcp_test/source/main"')
    expect(options.body).not.toContain(source)
  })

  it('round-trips only controlled V2 technical settings', async () => {
    const current = parseControlledTableSettings(settingsResponse)
    expect(current).toMatchObject({
      name: 'ZZIF_MCP_TEST', dataClass: 'APPL1', sizeCategory: 0,
      buffering: 'NOT_ALLOWED', storageType: 'C', loggingEnabled: false
    })
    const controlled = { dataClass: 'APPL1' as const, sizeCategory: 0, buffering: 'NOT_ALLOWED' as const, loggingEnabled: false }
    const xml = buildControlledTableSettingsXml(current, controlled)
    expect(xml).toContain('<ts:allowed>N</ts:allowed>')
    expect(xml).toContain('<ts:storageType>C</ts:storageType>')
    expect(xml).toContain('<ts:loggingEnabled>false</ts:loggingEnabled>')

    const client = http({ body: settingsResponse })
    await readControlledTableSettings(client, shell.name, 'workingArea')
    await writeControlledTableSettings(client, current, controlled, 'LOCK-2', shell.transportRequest)
    expect((client.request as jest.Mock).mock.calls[0]).toEqual([
      '/sap/bc/adt/ddic/db/settings/zzif_mcp_test', {
        headers: { Accept: 'application/vnd.sap.adt.table.settings.v1+xml, application/vnd.sap.adt.table.settings.v2+xml' },
        qs: { version: 'workingArea' }
      }
    ])
    expect((client.request as jest.Mock).mock.calls[1][1]).toMatchObject({
      method: 'PUT', qs: { lockHandle: 'LOCK-2', corrNr: 'S4HK900009' },
      headers: {
        'Content-Type': 'application/vnd.sap.adt.table.settings.v2+xml; charset=utf-8',
        Accept: 'application/vnd.sap.adt.table.settings.v1+xml, application/vnd.sap.adt.table.settings.v2+xml'
      }
    })
    expect(() => buildControlledTableSettingsXml(current, { ...controlled, buffering: 'FULL' as never })).toThrow('buffering')
  })

  it('activates table source and technical settings as separate ADT resources', async () => {
    const client = http({ body: activationResponse })
    await expect(activateControlledTable(client, shell.name)).resolves.toMatchObject({ success: true })
    await expect(activateControlledTableSettings(client, shell.name)).resolves.toMatchObject({ success: true })
    const calls = (client.request as jest.Mock).mock.calls
    expect(calls[0][0]).toBe('/sap/bc/adt/activation')
    expect(calls[0][1]).toMatchObject({ method: 'POST', qs: { method: 'activate', preauditRequested: true } })
    expect(calls[0][1].body).toContain('adtcore:uri="/sap/bc/adt/ddic/tables/zzif_mcp_test"')
    expect(calls[1][1].body).toContain('adtcore:uri="/sap/bc/adt/ddic/db/settings/zzif_mcp_test"')
  })
})
