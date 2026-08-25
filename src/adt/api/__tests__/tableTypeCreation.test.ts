import {
  buildControlledTableTypeShellXml,
  controlledTableTypeUrl,
  parseControlledTableType,
  readControlledAbapTypeCapabilities,
  validateControlledTableTypeShell,
  writeControlledTableType
} from '../tableTypeCreation'

describe('table type creation API', () => {
  const input = {
    name: 'ZZIF_MCP_TT', description: 'TEST TT', packageName: 'Z001', transportRequest: 'S4HK900009',
    language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  }

  it('builds the captured ADT 3.60.2 shell and canonical URL', () => {
    expect(buildControlledTableTypeShellXml(input)).toContain('adtcore:type="TTYP/DA"')
    expect(buildControlledTableTypeShellXml(input)).toContain('<adtcore:packageRef adtcore:name="Z001"/>')
    expect(controlledTableTypeUrl('ZZIF_MCP_TT')).toBe('/sap/bc/adt/ddic/tabletypes/zzif_mcp_tt')
  })

  it('parses the structured row type and key defaults', () => {
    const parsed = parseControlledTableType(`<?xml version="1.0"?><ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZIF_MCP_TT" adtcore:description="TEST TT" adtcore:version="new"><adtcore:packageRef adtcore:name="Z001"/><ttyp:rowType><ttyp:typeKind>predefinedAbapType</ttyp:typeKind><ttyp:typeName/><ttyp:builtInType><ttyp:dataType>CHAR</ttyp:dataType><ttyp:length>000040</ttyp:length><ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType><ttyp:rangeType/></ttyp:rowType><ttyp:initialRowCount>00000</ttyp:initialRowCount><ttyp:accessType>standard</ttyp:accessType><ttyp:primaryKey><ttyp:definition>standard</ttyp:definition><ttyp:kind>nonUnique</ttyp:kind></ttyp:primaryKey><ttyp:secondaryKeys><ttyp:allowed>notSpecified</ttyp:allowed></ttyp:secondaryKeys></ttyp:tableType>`)
    expect(parsed).toMatchObject({ name: 'ZZIF_MCP_TT', packageName: 'Z001', rowType: { typeKind: 'predefinedAbapType', dataType: 'CHAR', length: 40, decimals: 0 }, accessType: 'standard', primaryKey: { definition: 'standard', kind: 'nonUnique' } })
  })

  it('reads the server-advertised ABAP type capability rules', async () => {
    const client = { request: jest.fn().mockResolvedValue({ status: 200, headers: {}, body: '<abapsource:elementInfo xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="curr"><abapsource:properties><abapsource:entry abapsource:key="ddicPattern">curr(len,decimals)</abapsource:entry><abapsource:entry abapsource:key="ddicLengthMin">1 </abapsource:entry><abapsource:entry abapsource:key="ddicLengthMax">31 </abapsource:entry><abapsource:entry abapsource:key="ddicDecimalsMin">1 </abapsource:entry><abapsource:entry abapsource:key="ddicDecimalsMax">14 </abapsource:entry></abapsource:properties></abapsource:elementInfo>' }) }
    await expect(readControlledAbapTypeCapabilities(client as never)).resolves.toEqual([{ name: 'curr', pattern: 'curr(len,decimals)', lengthMin: 1, lengthMax: 31, decimalsMin: 1, decimalsMax: 14 }])
  })

  it('uses the TTYP validation query contract', async () => {
    const client = { request: jest.fn().mockResolvedValue({ status: 200, headers: {}, body: '' }) }
    await expect(validateControlledTableTypeShell(client as never, { name: 'ZZIF_MCP_TT', description: 'TEST TT' })).resolves.toEqual({ success: true })
    expect(client.request).toHaveBeenCalledWith('/sap/bc/adt/ddic/tabletypes/validation', expect.objectContaining({ qs: { objtype: 'ttypda', objname: 'ZZIF_MCP_TT', description: 'TEST TT' }, headers: { Accept: 'application/vnd.sap.as+xml' } }))
  })

  it.each([
    ['CURR', 10, 2],
    ['QUAN', 31, 14]
  ])('writes target-advertised %s values while preserving the ADT document shell', async (dataType, length, decimals) => {
    const client = {
      request: jest.fn()
        .mockResolvedValueOnce({ status: 200, headers: {}, body: '<ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZIF_MCP_TT" adtcore:description="TEST TT"><ttyp:rowType><ttyp:typeKind/><ttyp:typeName/><ttyp:builtInType><ttyp:dataType/><ttyp:length/><ttyp:decimals/></ttyp:builtInType><ttyp:rangeType/></ttyp:rowType><ttyp:initialRowCount/><ttyp:accessType/><ttyp:primaryKey><ttyp:definition/><ttyp:kind/></ttyp:primaryKey><ttyp:secondaryKeys><ttyp:allowed/></ttyp:secondaryKeys><ttyp:valueHelps><ttyp:typeKindValues/></ttyp:valueHelps></ttyp:tableType>' })
        .mockResolvedValueOnce({ status: 200, headers: {}, body: '<ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZIF_MCP_TT" adtcore:description="TEST TT"><ttyp:rowType><ttyp:typeKind>predefinedAbapType</ttyp:typeKind><ttyp:typeName/><ttyp:builtInType><ttyp:dataType>' + dataType + '</ttyp:dataType><ttyp:length>' + String(length).padStart(6, '0') + '</ttyp:length><ttyp:decimals>' + String(decimals).padStart(6, '0') + '</ttyp:decimals></ttyp:builtInType><ttyp:rangeType/></ttyp:rowType><ttyp:initialRowCount>00000</ttyp:initialRowCount><ttyp:accessType>standard</ttyp:accessType><ttyp:primaryKey><ttyp:definition>standard</ttyp:definition><ttyp:kind>nonUnique</ttyp:kind></ttyp:primaryKey><ttyp:secondaryKeys><ttyp:allowed>notSpecified</ttyp:allowed></ttyp:secondaryKeys><ttyp:valueHelps><ttyp:typeKindValues/></ttyp:valueHelps></ttyp:tableType>' })
    }
    await writeControlledTableType(client as never, 'ZZIF_MCP_TT', parseControlledTableType('<ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZIF_MCP_TT" adtcore:description="TEST TT"><ttyp:rowType><ttyp:typeKind/><ttyp:typeName/><ttyp:builtInType><ttyp:dataType/><ttyp:length/><ttyp:decimals/></ttyp:builtInType><ttyp:rangeType/></ttyp:rowType><ttyp:initialRowCount/><ttyp:accessType/><ttyp:primaryKey><ttyp:definition/><ttyp:kind/></ttyp:primaryKey><ttyp:secondaryKeys><ttyp:allowed/></ttyp:secondaryKeys><ttyp:valueHelps><ttyp:typeKindValues/></ttyp:valueHelps></ttyp:tableType>'), {
      rowType: { typeKind: 'predefinedAbapType', dataType, length, decimals },
      initialRowCount: 0,
      accessType: 'standard',
      primaryKey: { definition: 'standard', kind: 'nonUnique' },
      secondaryKeys: { allowed: 'notSpecified' }
    }, 'LOCK-1', 'S4HK900009')
    const body = client.request.mock.calls[0][1].body as string
    expect(body).toContain('<ttyp:dataType>' + dataType + '</ttyp:dataType>')
    expect(body).toContain('<ttyp:length>' + String(length).padStart(6, '0') + '</ttyp:length>')
    expect(body).toContain('<ttyp:decimals>' + String(decimals).padStart(6, '0') + '</ttyp:decimals>')
    expect(body).toContain('<ttyp:valueHelps><ttyp:typeKindValues/></ttyp:valueHelps>')
  })
})
