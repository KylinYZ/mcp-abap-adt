import {
  assertControlledSapObjectNodeTypeCreationContract,
  buildControlledSapObjectNodeTypeCreationContent,
  buildControlledSapObjectNodeTypeXml,
  controlledSapObjectNodeTypeUrl,
  createControlledSapObjectNodeType,
  parseControlledSapObjectNodeTypeContent,
  readControlledSapObjectNodeTypeContent,
  readControlledSapObjectNodeTypeCreationContract,
  validateControlledSapObjectNodeType
} from '../sapObjectNodeTypeCreation'

describe('SAP Object Node Type creation API', () => {
  const input = {
    repositoryName: 'ZMCPNONTTEST', semanticName: 'ZmcpNontTest', description: 'MCP SAP Object Node Type',
    packageName: 'Z001', transportRequest: 'S4HK900009', language: 'ZH', masterLanguage: 'ZH',
    masterSystem: 'S4H', responsible: '068157', sapObjectTypeName: 'ZMCPRONTTEST', rootNode: true
  }
  const creationContent = {
    name: 'ZmcpNontTest', sapObjectType: 'ZMCPRONTTEST', rootNode: true,
    metadata: { name: 'ZMCPNONTTEST', description: 'MCP SAP Object Node Type', package: 'Z001' }
  }
  const contract = {
    schema: {
      properties: {
        name: { type: 'string', maxLength: 30 },
        sapObjectType: { type: 'string', maxLength: 30 },
        rootNode: { type: 'boolean' },
        metadata: { properties: { name: {}, description: {}, package: {} } }
      },
      required: ['name', 'sapObjectType']
    },
    configuration: {
      properties: {
        name: { 'sap.adt.sideeffect': { determination: ['afterUpdate'] } },
        sapObjectType: { 'sap.adt.types': ['RONT'] },
        metadata: { properties: { name: { 'sap.adt.readonly': true } } }
      }
    },
    content: {}
  }

  it('embeds the reviewed reference and root-node choice in Blue v2', () => {
    expect(buildControlledSapObjectNodeTypeCreationContent(input)).toEqual(creationContent)
    const xml = buildControlledSapObjectNodeTypeXml(input, creationContent)
    expect(xml).toContain('adtcore:type="NONT/NOT"')
    expect(xml).toContain('<blue:additionalCreationProperties>')
    expect(xml).toContain('<adtcore:content adtcore:encoding="base64" adtcore:type="application/vnd.sap.adt.serverdriven.content.v1+json">')
    expect(xml).not.toContain('<adtcore:content encoding=')
    const encoded = xml.match(/<adtcore:content[^>]*>([^<]+)<\/adtcore:content>/)?.[1]
    expect(JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))).toEqual(creationContent)
    expect(controlledSapObjectNodeTypeUrl(input.repositoryName)).toBe('/sap/bc/adt/businessobjects/nontnot/zmcpnonttest')
  })

  it('validates with the uppercase RONT repository reference', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      body: '<asx:abap><asx:values><DATA><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>'
    }) }
    await expect(validateControlledSapObjectNodeType(client as never, input, creationContent)).resolves.toEqual({ success: true })
    expect(client.request).toHaveBeenCalledWith('/sap/bc/adt/businessobjects/nontnot/validation', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.sap.adt.serverdriven.content.v1+json',
        Accept: 'application/vnd.sap.as+xml'
      }
    }))
    const requestOptions = client.request.mock.calls[0][1]
    expect(JSON.parse(String(requestOptions.body))).toMatchObject({
      sapObjectType: 'ZMCPRONTTEST', rootNode: true
    })
  })

  it('reads and validates all three newObjectTypes.v1 contract resources', async () => {
    const client = { request: jest.fn()
      .mockResolvedValueOnce({ body: JSON.stringify(contract.schema) })
      .mockResolvedValueOnce({ body: JSON.stringify(contract.configuration) })
      .mockResolvedValueOnce({ body: '{}' }) }
    await expect(readControlledSapObjectNodeTypeCreationContract(client as never)).resolves.toEqual(contract)
    expect(() => assertControlledSapObjectNodeTypeCreationContract(contract)).not.toThrow()
    expect(() => assertControlledSapObjectNodeTypeCreationContract({
      ...contract,
      configuration: { properties: { ...contract.configuration.properties, sapObjectType: { 'sap.adt.types': ['NONT'] } } }
    })).toThrow('ADT 3.60.2')
  })

  it('requires HTTP 201 and the canonical Blue response identity', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      status: 201,
      headers: { location: '/sap/bc/adt/businessobjects/nontnot/zmcpnonttest' },
      body: '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZMCPNONTTEST" adtcore:type="NONT/NOT"><adtcore:packageRef adtcore:name="Z001"/></blue:blueSource>'
    }) }
    await expect(createControlledSapObjectNodeType(
      client as never, input, creationContent, 'application/vnd.sap.adt.blues.v2+xml'
    )).resolves.toMatchObject({
      location: '/sap/bc/adt/businessobjects/nontnot/zmcpnonttest',
      sapObjectNodeType: { name: 'ZMCPNONTTEST', packageName: 'Z001' }
    })
  })

  it('parses canonical active JSON and permits omitted false rootNode', async () => {
    const active = {
      formatVersion: '1',
      header: { description: 'MCP SAP Object Node Type', originalLanguage: 'zh' },
      name: 'ZmcpNontTest', sapObjectType: 'ZmcpRontTest', rootNode: true
    }
    expect(parseControlledSapObjectNodeTypeContent(active)).toEqual(active)
    expect(parseControlledSapObjectNodeTypeContent({ ...active, rootNode: undefined })).toEqual({
      formatVersion: '1', header: active.header, name: active.name, sapObjectType: active.sapObjectType
    })
    const client = { request: jest.fn().mockResolvedValue({ body: JSON.stringify(active) }) }
    await expect(readControlledSapObjectNodeTypeContent(
      client as never,
      '/sap/bc/adt/businessobjects/nontnot/zmcpnonttest/source/main',
      'application/json; charset=utf-8',
      'active'
    )).resolves.toEqual(active)
    expect(() => parseControlledSapObjectNodeTypeContent({ ...active, unexpected: true })).toThrow('nont-v1')
    await expect(readControlledSapObjectNodeTypeContent(
      client as never,
      '/sap/bc/adt/businessobjects/nontnot/zmcpnonttest/source/main',
      'text/plain',
      'active'
    )).rejects.toThrow('application/json')
  })
})
