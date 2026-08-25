import {
  assertControlledSapObjectTypeCreationContract,
  buildControlledSapObjectTypeCreationContent,
  buildControlledSapObjectTypeXml,
  controlledSapObjectTypeUrl,
  createControlledSapObjectType,
  parseControlledSapObjectTypeContent,
  readControlledSapObjectTypeContent,
  readControlledSapObjectTypeCreationContract,
  validateControlledSapObjectType
} from '../sapObjectTypeCreation'

describe('SAP Object Type creation API', () => {
  const input = {
    repositoryName: 'ZMCPRONTTEST', semanticName: 'ZmcpRontTest', description: 'MCP SAP Object Type',
    packageName: 'Z001', transportRequest: 'S4HK900009', language: 'ZH', masterLanguage: 'ZH',
    masterSystem: 'S4H', responsible: '068157', typeCategory: 'businessObject' as const
  }
  const creationContent = {
    name: 'ZmcpRontTest', typeCategory: 'bo' as const,
    metadata: { name: 'ZMCPRONTTEST', description: 'MCP SAP Object Type', package: 'Z001' }
  }
  const contract = {
    schema: {
      properties: {
        name: { type: 'string', maxLength: 30 },
        typeCategory: { type: 'string', enum: ['bo', 'to', 'ao', 'co', 'do', 'ho'] },
        metadata: { properties: { name: {}, description: {}, package: {} } }
      },
      required: ['name']
    },
    configuration: {
      properties: {
        name: { 'sap.adt.sideeffect': { determination: ['afterUpdate'] } },
        metadata: { properties: { name: { 'sap.adt.readonly': true } } }
      }
    },
    content: {}
  }

  it('maps reviewed categories and embeds the creation JSON in Blue v2', () => {
    expect(buildControlledSapObjectTypeCreationContent(input)).toEqual(creationContent)
    const xml = buildControlledSapObjectTypeXml(input, creationContent)
    expect(xml).toContain('adtcore:type="RONT/ROT"')
    expect(xml).toContain('<blue:additionalCreationProperties>')
    expect(xml).toContain('<adtcore:content adtcore:encoding="base64" adtcore:type="application/vnd.sap.adt.serverdriven.content.v1+json">')
    expect(xml).not.toContain('<adtcore:content encoding=')
    const encoded = xml.match(/<adtcore:content[^>]*>([^<]+)<\/adtcore:content>/)?.[1]
    expect(JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))).toEqual(creationContent)
    expect(controlledSapObjectTypeUrl(input.repositoryName)).toBe('/sap/bc/adt/businessobjects/rontrot/zmcpronttest')
  })

  it('uses the target validation content and response media types', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      body: '<asx:abap><asx:values><DATA><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>'
    }) }
    await expect(validateControlledSapObjectType(client as never, input, creationContent)).resolves.toEqual({ success: true })
    expect(client.request).toHaveBeenCalledWith('/sap/bc/adt/businessobjects/rontrot/validation', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.sap.adt.serverdriven.content.v1+json',
        Accept: 'application/vnd.sap.as+xml'
      },
      body: JSON.stringify(creationContent)
    }))
  })

  it('reads and validates all three newObjectTypes.v1 contract resources', async () => {
    const client = { request: jest.fn()
      .mockResolvedValueOnce({ body: JSON.stringify(contract.schema) })
      .mockResolvedValueOnce({ body: JSON.stringify(contract.configuration) })
      .mockResolvedValueOnce({ body: '{}' }) }
    await expect(readControlledSapObjectTypeCreationContract(client as never)).resolves.toEqual(contract)
    expect(() => assertControlledSapObjectTypeCreationContract(contract)).not.toThrow()
    expect(() => assertControlledSapObjectTypeCreationContract({ ...contract, content: { unexpected: true } })).toThrow('ADT 3.60.2')
  })

  it('requires HTTP 201 and the canonical Blue response identity', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      status: 201,
      headers: { location: '/sap/bc/adt/businessobjects/rontrot/zmcpronttest' },
      body: '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZMCPRONTTEST" adtcore:type="RONT/ROT"><adtcore:packageRef adtcore:name="Z001"/></blue:blueSource>'
    }) }
    await expect(createControlledSapObjectType(
      client as never, input, creationContent, 'application/vnd.sap.adt.blues.v2+xml'
    )).resolves.toMatchObject({
      location: '/sap/bc/adt/businessobjects/rontrot/zmcpronttest',
      sapObjectType: { name: 'ZMCPRONTTEST', packageName: 'Z001' }
    })
  })

  it('accepts an empty Blue shell response when HTTP 201 has canonical Location', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      status: 201,
      headers: { location: '/sap/bc/adt/businessobjects/rontrot/zmcpronttest' },
      body: ''
    }) }
    await expect(createControlledSapObjectType(
      client as never, input, creationContent, 'application/vnd.sap.adt.blues.v2+xml'
    )).resolves.toEqual({
      location: '/sap/bc/adt/businessobjects/rontrot/zmcpronttest',
      sapObjectType: { name: 'ZMCPRONTTEST' }
    })
  })

  it('still rejects a non-empty Blue response without matching identity', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      status: 201,
      headers: { location: '/sap/bc/adt/businessobjects/rontrot/zmcpronttest' },
      body: '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue"/>'
    }) }
    await expect(createControlledSapObjectType(
      client as never, input, creationContent, 'application/vnd.sap.adt.blues.v2+xml'
    )).rejects.toThrow('response identity')
  })

  it('parses only canonical application/json source with a generated type code', async () => {
    const content = {
      formatVersion: '1',
      header: { description: 'MCP SAP Object Type', originalLanguage: 'zh' },
      typeCategory: 'businessObject', name: 'ZmcpRontTest', objectTypeCode: '9001'
    }
    expect(parseControlledSapObjectTypeContent(content)).toEqual(content)
    const client = { request: jest.fn().mockResolvedValue({ body: JSON.stringify(content) }) }
    await expect(readControlledSapObjectTypeContent(
      client as never,
      '/sap/bc/adt/businessobjects/rontrot/zmcpronttest/source/main',
      'application/json; charset=utf-8',
      'active'
    )).resolves.toEqual(content)
    expect(parseControlledSapObjectTypeContent({ ...content, objectTypeCode: undefined })).toEqual({ ...content, objectTypeCode: undefined })
    expect(() => parseControlledSapObjectTypeContent({ ...content, objectTypeCode: '' })).toThrow('objectTypes.v1')
    expect(() => parseControlledSapObjectTypeContent({ ...content, objectTypeCode: '123456' })).toThrow('objectTypes.v1')
    await expect(readControlledSapObjectTypeContent(
      client as never,
      '/sap/bc/adt/businessobjects/rontrot/zmcpronttest/source/main',
      'text/plain',
      'active'
    )).rejects.toThrow('application/json')
  })
})
