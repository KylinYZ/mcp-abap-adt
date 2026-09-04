import {
  type AdtHTTP,
  buildControlledServiceBindingXml,
  createControlledServiceBinding,
  parseServiceBindingConfiguration,
  parseServiceBindingIdentity,
  validateControlledServiceBinding,
  type ControlledServiceBindingInput
} from '../adt/index.js'

const input: ControlledServiceBindingInput = {
  objectKind: 'SERVICE_BINDING', adtType: 'SRVB/SVB', name: 'ZUI_MCP_BINDING',
  description: 'MCP service binding', packageName: 'Z001', serviceDefinition: 'ZUI_MCP_SERVICE',
  bindingType: 'ODATA_V4_WEB_API', bindingCategory: '1', transportRequest: 'S4HK900009',
  language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
}

const validationResponse = '<asx:abap><asx:values><DATA><SEVERITY>S</SEVERITY><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>'

function bindingResponse(type = 'V4', category = '1'): string {
  return `<?xml version="1.0"?><srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZUI_MCP_BINDING" adtcore:type="SRVB/SVB"><atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="x"/><adtcore:packageRef adtcore:name="Z001"/><srvb:services srvb:name="ZUI_MCP_BINDING"><srvb:content srvb:version="0001"><srvb:serviceDefinition adtcore:name="ZUI_MCP_SERVICE"/></srvb:content></srvb:services><srvb:binding srvb:type="ODATA" srvb:version="${type}" srvb:category="${category}"><srvb:implementation adtcore:name=""/></srvb:binding></srvb:serviceBinding>`
}

function http(response: Partial<{ body: string; status: number; headers: Record<string, string> }> = {}) {
  return {
    request: jest.fn().mockResolvedValue({ body: '', status: 200, statusText: 'OK', headers: {}, ...response })
  } as unknown as AdtHTTP
}

describe('controlled service binding ADT contract', () => {
  it('uses the fixed validation endpoint and exact V4/Web API query mapping', async () => {
    const client = http({ body: validationResponse })
    await expect(validateControlledServiceBinding(client, input)).resolves.toMatchObject({ success: true })
    expect((client.request as jest.Mock).mock.calls[0]).toEqual([
      '/sap/bc/adt/businessservices/bindings/validation',
      {
        method: 'POST',
        qs: {
          objname: 'ZUI_MCP_BINDING', description: 'MCP service binding', objtype: 'SRVB/SVB',
          serviceBindingVersion: 'ODATA\\V4', serviceDefinition: 'ZUI_MCP_SERVICE', package: 'Z001'
        },
        headers: { Accept: 'application/vnd.sap.as+xml' }
      }
    ])
  })

  it.each([
    ['ODATA_V2_UI', 'V2', '0'], ['ODATA_V2_WEB_API', 'V2', '1'],
    ['ODATA_V4_UI', 'V4', '0'], ['ODATA_V4_WEB_API', 'V4', '1']
  ] as const)('builds the Eclipse binding XML for %s', (bindingType, version, category) => {
    const xml = buildControlledServiceBindingXml({ ...input, bindingType, bindingCategory: category })
    expect(xml).toContain('<srvb:serviceBinding')
    expect(xml).toContain('xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"')
    expect(xml).toContain(`srvb:version="${version}"`)
    expect(xml).toContain(`srvb:category="${category}"`)
    expect(xml).toContain('srvb:serviceDefinition adtcore:name="ZUI_MCP_SERVICE"')
  })

  it('requires the canonical Location and rejects response identity drift', async () => {
    const client = http({ body: bindingResponse(), status: 201, headers: { location: '/sap/bc/adt/businessservices/bindings/zui_mcp_binding' } })
    await expect(createControlledServiceBinding(client, input)).resolves.toMatchObject({
      location: '/sap/bc/adt/businessservices/bindings/zui_mcp_binding', name: 'ZUI_MCP_BINDING', adtType: 'SRVB/SVB'
    })
    const request = (client.request as jest.Mock).mock.calls[0]
    expect(request[0]).toBe('/sap/bc/adt/businessservices/bindings')
    expect(request[1]).toMatchObject({ method: 'POST', qs: { corrNr: 'S4HK900009' }, headers: {
      'Content-Type': 'application/vnd.sap.adt.businessservices.servicebinding.v2+xml',
      Accept: 'application/vnd.sap.adt.businessservices.servicebinding.v2+xml'
    } })
    await expect(createControlledServiceBinding(http({
      body: bindingResponse().replace('ZUI_MCP_BINDING', 'ZOTHER'), status: 201,
      headers: { location: '/sap/bc/adt/businessservices/bindings/zui_mcp_binding' }
    }), input)).rejects.toThrow('identity')
  })

  it('parses the stable identity and configuration fields used after creation', () => {
    const xml = bindingResponse()
    expect(parseServiceBindingIdentity(xml)).toEqual({ name: 'ZUI_MCP_BINDING', adtType: 'SRVB/SVB' })
    expect(parseServiceBindingConfiguration(xml)).toEqual({
      serviceDefinition: 'ZUI_MCP_SERVICE', bindingType: 'ODATA', bindingVersion: 'V4', bindingCategory: '1'
    })
  })
})
