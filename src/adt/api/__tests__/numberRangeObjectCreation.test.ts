import {
  assertControlledNumberRangeObjectSchema,
  buildControlledNumberRangeObjectShellXml,
  controlledNumberRangeObjectUrl,
  createControlledNumberRangeObjectShell,
  parseControlledNumberRangeObjectContent,
  readControlledNumberRangeObjectContent,
  validateControlledNumberRangeObject,
  writeControlledNumberRangeObjectContent
} from '../numberRangeObjectCreation'

describe('number range object creation API', () => {
  const input = {
    name: 'ZZMCPNR01', description: 'MCP number range', packageName: 'Z001', transportRequest: 'S4HK900009',
    language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  }
  const content = {
    formatVersion: '1' as const,
    header: { description: 'MCP number range', originalLanguage: 'zh', abapLanguageVersion: 'standard' as const },
    interval: {
      numberLengthDomain: 'CHAR10', percentWarning: 10, subType: '',
      untilYear: false, rolling: true, prefix: false
    },
    configuration: { buffering: 'mainBuffer' as const, bufferedNumbers: 10 }
  }
  const schema = {
    properties: {
      formatVersion: {},
      header: { properties: { description: {}, originalLanguage: {}, abapLanguageVersion: { enum: ['standard', 'cloudDevelopment'] } } },
      interval: {
        properties: { numberLengthDomain: {}, percentWarning: {}, subType: {}, untilYear: {}, rolling: {}, prefix: {} },
        required: ['numberLengthDomain', 'percentWarning', 'untilYear', 'rolling', 'prefix']
      },
      configuration: {
        properties: { transactionId: {}, buffering: { enum: ['mainBuffer', 'parallel', 'none'] }, bufferedNumbers: {} },
        required: ['buffering', 'bufferedNumbers']
      }
    }
  }

  it('builds the Blue v1 shell and canonical URL', () => {
    expect(buildControlledNumberRangeObjectShellXml(input)).toContain('adtcore:type="NROB/NRO"')
    expect(controlledNumberRangeObjectUrl(input.name)).toBe('/sap/bc/adt/numberranges/objects/zzmcpnr01')
  })

  it('uses the target validation response media type', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      body: '<asx:abap><asx:values><DATA><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>'
    }) }
    await expect(validateControlledNumberRangeObject(client as never, input)).resolves.toEqual({ success: true })
    expect(client.request).toHaveBeenCalledWith('/sap/bc/adt/numberranges/objects/validation', expect.objectContaining({
      qs: { objtype: 'NROB/NRO', objname: input.name, description: input.description, packagename: input.packageName },
      headers: { Accept: 'application/vnd.sap.as+xml' }
    }))
  })

  it('accepts the reviewed schema and rejects incomplete variants', () => {
    expect(() => assertControlledNumberRangeObjectSchema(schema)).not.toThrow()
    expect(() => assertControlledNumberRangeObjectSchema({ properties: {} })).toThrow()
  })

  it('requires HTTP 201 and the canonical shell identity', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      status: 201,
      headers: { location: '/sap/bc/adt/numberranges/objects/zzmcpnr01' },
      body: '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZMCPNR01" adtcore:type="NROB/NRO"><adtcore:packageRef adtcore:name="Z001"/></blue:blueSource>'
    }) }
    await expect(createControlledNumberRangeObjectShell(client as never, input, 'application/vnd.sap.adt.blues.v1+xml'))
      .resolves.toMatchObject({ location: '/sap/bc/adt/numberranges/objects/zzmcpnr01', numberRangeObject: { name: 'ZZMCPNR01' } })
  })

  it('reads and writes only canonical application/json content', async () => {
    const client = {
      isStateful: true,
      request: jest.fn().mockResolvedValue({ body: JSON.stringify(content) })
    }
    await expect(readControlledNumberRangeObjectContent(client as never, '/sap/bc/adt/numberranges/objects/zzmcpnr01/source/main', 'application/json; charset=utf-8', 'inactive')).resolves.toEqual(content)
    await expect(writeControlledNumberRangeObjectContent(client as never, '/sap/bc/adt/numberranges/objects/zzmcpnr01/source/main', content, 'application/json', 'LOCK-1', 'S4HK900009')).resolves.toEqual(content)
    expect(client.request).toHaveBeenLastCalledWith('/sap/bc/adt/numberranges/objects/zzmcpnr01/source/main', expect.objectContaining({
      method: 'PUT', qs: { lockHandle: 'LOCK-1', corrNr: 'S4HK900009' }
    }))
    await expect(readControlledNumberRangeObjectContent(client as never, '/sap/bc/adt/numberranges/objects/zzmcpnr01/source/main', 'text/plain', 'inactive')).rejects.toThrow('application/json')
  })

  it('normalizes omitted optional fields and rejects invalid values', () => {
    expect(parseControlledNumberRangeObjectContent({
      ...content,
      header: { description: 'MCP number range', originalLanguage: 'zh' },
      interval: { ...content.interval, subType: undefined }
    })).toMatchObject({
      header: { abapLanguageVersion: 'standard' },
      interval: { subType: '' }
    })
    expect(() => parseControlledNumberRangeObjectContent({
      ...content,
      interval: { ...content.interval, percentWarning: 100 }
    })).toThrow('objectTypes.v1')
  })
})
