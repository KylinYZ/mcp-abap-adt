import {
  assertControlledLogicalExternalSchemaSchema,
  buildControlledLogicalExternalSchemaShellXml,
  controlledLogicalExternalSchemaUrl,
  createControlledLogicalExternalSchemaShell,
  parseControlledLogicalExternalSchemaContent,
  readControlledLogicalExternalSchemaContent,
  validateControlledLogicalExternalSchema,
  writeControlledLogicalExternalSchemaContent
} from '../logicalExternalSchemaCreation'

describe('logical external schema creation API', () => {
  const input = {
    name: 'ZZIF_MCP_SCHEMA', description: 'MCP schema', packageName: 'Z001', transportRequest: 'S4HK900009',
    language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  }

  it('builds the Blue v1 shell and canonical URL', () => {
    expect(buildControlledLogicalExternalSchemaShellXml(input)).toContain('adtcore:type="DESD/TYP"')
    expect(controlledLogicalExternalSchemaUrl(input.name)).toBe('/sap/bc/adt/ddic/desd/zzif_mcp_schema')
  })

  it('uses the Eclipse validation query contract', async () => {
    const client = { request: jest.fn().mockResolvedValue({ body: '' }) }
    await expect(validateControlledLogicalExternalSchema(client as never, input)).resolves.toEqual({ success: true })
    expect(client.request).toHaveBeenCalledWith('/sap/bc/adt/ddic/desd/validation', expect.objectContaining({
      qs: { objtype: 'DESD/TYP', objname: input.name, description: input.description, packagename: input.packageName },
      headers: { Accept: 'application/vnd.sap.as+xml' }
    }))
  })

  it('parses routing for the adapter to enforce and rejects incomplete schemas', () => {
    expect(() => parseControlledLogicalExternalSchemaContent({
      formatVersion: '1',
      header: { description: 'x', originalLanguage: 'zh', abapLanguageVersion: 'standard' },
      generalInformation: { usesRouting: true }
    })).not.toThrow()
    expect(() => assertControlledLogicalExternalSchemaSchema({ properties: {} })).toThrow()
  })

  it('requires HTTP 201 and the canonical shell identity', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      status: 201,
      headers: { location: '/sap/bc/adt/ddic/desd/zzif_mcp_schema' },
      body: '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZIF_MCP_SCHEMA" adtcore:type="DESD/TYP"><adtcore:packageRef adtcore:name="Z001"/></blue:blueSource>'
    }) }
    await expect(createControlledLogicalExternalSchemaShell(client as never, input, 'application/vnd.sap.adt.blues.v1+xml'))
      .resolves.toMatchObject({ location: '/sap/bc/adt/ddic/desd/zzif_mcp_schema', logicalExternalSchema: { name: 'ZZIF_MCP_SCHEMA' } })
  })

  it('reads and writes only the reviewed JSON contract', async () => {
    const content = {
      formatVersion: '1' as const,
      header: { description: 'MCP schema', originalLanguage: 'zh', abapLanguageVersion: 'standard' as const },
      generalInformation: { defaultRemoteSchemaName: 'REMOTE_SCHEMA' }
    }
    const client = {
      isStateful: true,
      request: jest.fn().mockResolvedValue({ body: JSON.stringify(content) })
    }
    await expect(readControlledLogicalExternalSchemaContent(client as never, '/sap/bc/adt/ddic/desd/zzif_mcp_schema/source/main', 'application/json; charset=UTF-8', 'inactive')).resolves.toEqual(content)
    await expect(writeControlledLogicalExternalSchemaContent(client as never, '/sap/bc/adt/ddic/desd/zzif_mcp_schema/source/main', content, 'application/json', 'LOCK-1', 'S4HK900009')).resolves.toEqual(content)
    expect(client.request).toHaveBeenLastCalledWith('/sap/bc/adt/ddic/desd/zzif_mcp_schema/source/main', expect.objectContaining({
      method: 'PUT', qs: { lockHandle: 'LOCK-1', corrNr: 'S4HK900009' }
    }))
    expect(client.request).toHaveBeenLastCalledWith('/sap/bc/adt/ddic/desd/zzif_mcp_schema/source/main', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
    }))
    await expect(readControlledLogicalExternalSchemaContent(client as never, '/sap/bc/adt/ddic/desd/zzif_mcp_schema/source/main', 'application/vnd.sap.adt.serverdriven.content.v1+json; framework=objectTypes.v1', 'inactive')).rejects.toThrow('reviewed application/json')
    await expect(readControlledLogicalExternalSchemaContent(client as never, '/sap/bc/adt/ddic/desd/zzif_mcp_schema/source/main', 'application/problem+json', 'inactive')).rejects.toThrow('reviewed application/json')
    await expect(readControlledLogicalExternalSchemaContent(client as never, '/sap/bc/adt/ddic/desd/zzif_mcp_schema/source/main', 'application/json; framework=objectTypes.v1', 'inactive')).rejects.toThrow('unsupported application/json parameters')
    await expect(readControlledLogicalExternalSchemaContent(client as never, '/sap/bc/adt/ddic/desd/zzif_mcp_schema/source/main', 'application/json; charset=utf-8; profile=unexpected', 'inactive')).rejects.toThrow('unsupported application/json parameters')
  })

  it('accepts SAP read-back that omits optional language and general information', () => {
    expect(parseControlledLogicalExternalSchemaContent({
      formatVersion: '1',
      header: { description: 'Dummy schema', originalLanguage: 'en' }
    })).toEqual({
      formatVersion: '1',
      header: { description: 'Dummy schema', originalLanguage: 'en' },
      generalInformation: {}
    })
  })
})
