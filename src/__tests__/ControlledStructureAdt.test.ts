import {
  activateControlledStructure,
  buildControlledStructureShellXml,
  createControlledStructureShell,
  parseControlledStructure,
  validateControlledStructureShell,
  type AdtHTTP,
  type ControlledStructureShellInput
} from '../adt/index.js'

const shell: ControlledStructureShellInput = {
  name: 'ZZIF_MCP_STRUCT', description: 'MCP结构', packageName: 'Z001', transportRequest: 'S4HK900009',
  language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
}
const response = `<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core" abapsource:sourceUri="./zzif_mcp_struct/source/main" adtcore:name="ZZIF_MCP_STRUCT" adtcore:type="TABL/DS" adtcore:version="inactive" adtcore:description="MCP结构"><adtcore:packageRef adtcore:name="Z001"/></blue:blueSource>`

function http(body = '', status = 200, headers: Record<string, string> = {}): AdtHTTP {
  return { request: jest.fn().mockResolvedValue({ body, status, headers }) } as unknown as AdtHTTP
}

describe('controlled DDIC structure ADT contract', () => {
  it('builds and validates a TABL/DS shell', async () => {
    const validation = http('<asx:abap><asx:values><DATA><SEVERITY>S</SEVERITY><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>')
    await expect(validateControlledStructureShell(validation, shell)).resolves.toMatchObject({ success: true })
    expect((validation.request as jest.Mock).mock.calls[0][0]).toBe('/sap/bc/adt/ddic/structures/validation')
    expect(buildControlledStructureShellXml(shell)).toContain('adtcore:type="TABL/DS"')
  })

  it('requires the ADT-discovered content type and canonical identity', async () => {
    const client = http(response, 201, { location: '/sap/bc/adt/ddic/structures/zzif_mcp_struct' })
    await expect(createControlledStructureShell(client, shell, 'application/vnd.sap.adt.blues.v1+xml')).resolves.toMatchObject({
      location: '/sap/bc/adt/ddic/structures/zzif_mcp_struct', structure: { name: 'ZZIF_MCP_STRUCT', packageName: 'Z001' }
    })
    expect((client.request as jest.Mock).mock.calls[0][1]).toMatchObject({
      headers: { 'Content-Type': 'application/vnd.sap.adt.blues.v1+xml', Accept: 'application/vnd.sap.adt.blues.v1+xml' }
    })
    await expect(createControlledStructureShell(client, shell, '')).rejects.toThrow('content type')
    expect(parseControlledStructure(response)).toMatchObject({ name: 'ZZIF_MCP_STRUCT', sourceUri: './zzif_mcp_struct/source/main' })
  })

  it('accepts an empty shell response when HTTP 201 has canonical Location', async () => {
    const client = http('', 201, { location: '/sap/bc/adt/ddic/structures/zzif_mcp_struct' })
    await expect(createControlledStructureShell(client, shell, 'application/vnd.sap.adt.blues.v1+xml')).resolves.toEqual({
      location: '/sap/bc/adt/ddic/structures/zzif_mcp_struct', structure: { name: 'ZZIF_MCP_STRUCT' }
    })
  })

  it('accepts a protocol-relative canonical Location with fragment and trailing slash', async () => {
    const location = '//dev.example.test/sap/bc/adt/ddic/structures/zzif_mcp_struct/#created'
    const client = http('', 201, { location })
    await expect(createControlledStructureShell(client, shell, 'application/vnd.sap.adt.blues.v1+xml')).resolves.toEqual({
      location, structure: { name: 'ZZIF_MCP_STRUCT' }
    })
  })

  it('activates the structure resource', async () => {
    const client = http('<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><chkl:properties activationExecuted="true"/></chkl:messages>')
    await expect(activateControlledStructure(client, shell.name)).resolves.toMatchObject({ success: true })
    expect((client.request as jest.Mock).mock.calls[0][1].body).toContain('/sap/bc/adt/ddic/structures/zzif_mcp_struct')
  })
})
