import {
  assertControlledChangeDocumentObjectContract,
  buildControlledChangeDocumentObjectShellXml,
  controlledChangeDocumentObjectUrl,
  createControlledChangeDocumentObjectShell,
  parseControlledChangeDocumentObjectContent,
  readControlledChangeDocumentObjectContent,
  readControlledChangeDocumentObjectContract,
  toSapChangeDocumentObjectCategory,
  validateControlledChangeDocumentObject,
  writeControlledChangeDocumentObjectContent
} from '../changeDocumentObjectCreation'

describe('Change Document Object creation API', () => {
  const input = {
    name: 'ZZMCPCHDO', description: 'MCP change document', packageName: 'Z001', transportRequest: 'S4HK900009',
    language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  }
  const content = {
    formatVersion: '1' as const,
    header: { description: 'MCP change document', originalLanguage: 'zh', abapLanguageVersion: 'standard' as const },
    generalInformation: { category: 'standard' as const },
    tablesAndStructures: [{
      name: 'ZZIF_MCP_TEST', referenceTable: '', multipleChanges: true,
      databaseInsertions: { logValues: false, logInitialValues: false },
      databaseDeletions: { logValues: false, logInitialValues: false }
    }],
    errorMessage: { id: 'CD', number: '600' }
  }
  const contract = {
    schema: {
      properties: {
        formatVersion: {},
        header: { properties: { description: {}, originalLanguage: {}, abapLanguageVersion: { enum: ['standard', 'cloudDevelopment'] } } },
        generalInformation: { properties: { category: { enum: ['standard', 'behaviorDefiniton'] }, generatedObject: {} } },
        tablesAndStructures: {
          items: {
            properties: {
              name: {}, referenceTable: {}, multipleChanges: {},
              databaseInsertions: { properties: { logValues: {}, logInitialValues: {} } },
              databaseDeletions: { properties: { logValues: {}, logInitialValues: {} } }
            }
          }
        },
        errorMessage: { properties: { id: {}, number: {} } }
      },
      required: ['formatVersion', 'header', 'tablesAndStructures', 'errorMessage']
    },
    configuration: {
      properties: {
        generalInformation: { properties: { generatedObject: { 'sap.adt.types': ['CLAS', 'FUNC'] } } },
        tablesAndStructures: { items: { properties: { name: { 'sap.adt.types': ['TABL'] }, referenceTable: { 'sap.adt.types': ['TABL'] } } } },
        errorMessage: { properties: { id: { 'sap.adt.types': ['MSAG'] } } }
      }
    }
  }

  it('builds the Blue v1 shell, canonical URL, and SAP category spelling', () => {
    expect(buildControlledChangeDocumentObjectShellXml(input)).toContain('adtcore:type="CHDO/CHD"')
    expect(controlledChangeDocumentObjectUrl(input.name)).toBe('/sap/bc/adt/changedocuments/objects/zzmcpchdo')
    expect(toSapChangeDocumentObjectCategory('behaviorDefinition')).toBe('behaviorDefiniton')
  })

  it('uses the reviewed validation request contract', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      body: '<asx:abap><asx:values><DATA><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>'
    }) }
    await expect(validateControlledChangeDocumentObject(client as never, input)).resolves.toEqual({ success: true })
    expect(client.request).toHaveBeenCalledWith('/sap/bc/adt/changedocuments/objects/validation', expect.objectContaining({
      qs: { objtype: 'CHDO/CHD', objname: input.name, description: input.description, packagename: input.packageName },
      headers: { Accept: 'application/vnd.sap.as+xml' }
    }))
  })

  it('reads and validates both objectTypes.v1 contract resources', async () => {
    const client = { request: jest.fn()
      .mockResolvedValueOnce({ body: JSON.stringify(contract.schema) })
      .mockResolvedValueOnce({ body: JSON.stringify(contract.configuration) }) }
    await expect(readControlledChangeDocumentObjectContract(client as never)).resolves.toEqual(contract)
    expect(() => assertControlledChangeDocumentObjectContract(contract)).not.toThrow()
    expect(() => assertControlledChangeDocumentObjectContract({
      ...contract,
      configuration: { properties: { ...contract.configuration.properties, errorMessage: { properties: { id: { 'sap.adt.types': ['TEXT'] } } } } }
    })).toThrow('ADT 3.60.2')
  })

  it('requires HTTP 201 and the canonical shell identity', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      status: 201,
      headers: { location: '/sap/bc/adt/changedocuments/objects/zzmcpchdo' },
      body: '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZMCPCHDO" adtcore:type="CHDO/CHD"><adtcore:packageRef adtcore:name="Z001"/></blue:blueSource>'
    }) }
    await expect(createControlledChangeDocumentObjectShell(client as never, input, 'application/vnd.sap.adt.blues.v1+xml'))
      .resolves.toMatchObject({
        location: '/sap/bc/adt/changedocuments/objects/zzmcpchdo',
        changeDocumentObject: { name: 'ZZMCPCHDO', packageName: 'Z001' }
      })
  })

  it('reads and writes only canonical application/json content', async () => {
    const client = { isStateful: true, request: jest.fn().mockResolvedValue({ body: JSON.stringify(content) }) }
    await expect(readControlledChangeDocumentObjectContent(
      client as never,
      '/sap/bc/adt/changedocuments/objects/zzmcpchdo/source/main',
      'application/json; charset=utf-8',
      'inactive'
    )).resolves.toEqual(content)
    await expect(writeControlledChangeDocumentObjectContent(
      client as never,
      '/sap/bc/adt/changedocuments/objects/zzmcpchdo/source/main',
      content,
      'application/json',
      'LOCK-1',
      'S4HK900009'
    )).resolves.toEqual(content)
    expect(client.request).toHaveBeenLastCalledWith(
      '/sap/bc/adt/changedocuments/objects/zzmcpchdo/source/main',
      expect.objectContaining({ method: 'PUT', qs: { lockHandle: 'LOCK-1', corrNr: 'S4HK900009' } })
    )
    await expect(readControlledChangeDocumentObjectContent(
      client as never,
      '/sap/bc/adt/changedocuments/objects/zzmcpchdo/source/main',
      'text/plain',
      'active'
    )).rejects.toThrow('application/json')
  })

  it('normalizes active defaults and rejects unknown or invalid content', () => {
    expect(parseControlledChangeDocumentObjectContent({
      ...content,
      header: { description: content.header.description, originalLanguage: 'zh' },
      generalInformation: { generatedObject: 'ZZMCPCHDO_WRITE_DOCUMENT' }
    })).toMatchObject({
      header: { abapLanguageVersion: 'standard' },
      generalInformation: { generatedObject: 'ZZMCPCHDO_WRITE_DOCUMENT' }
    })
    expect(() => parseControlledChangeDocumentObjectContent({ ...content, generatedObject: 'CALLER_VALUE' }))
      .toThrow('unsupported property')
    expect(() => parseControlledChangeDocumentObjectContent({
      ...content,
      errorMessage: { id: 'CD', number: '60' }
    })).toThrow('chdo-v1')
  })
})
