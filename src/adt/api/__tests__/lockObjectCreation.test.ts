import {
  buildControlledLockObjectShellXml,
  controlledLockObjectUrl,
  createControlledLockObjectShell,
  parseControlledLockObject,
  validateControlledLockObjectShell
} from '../lockObjectCreation'

describe('lock object creation API', () => {
  const input = {
    name: 'ZZENQCHK', description: 'MCP lock object', packageName: 'Z001', primaryTable: 'ZZIF_MCP_TEST', transportRequest: 'S4HK900009',
    language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  }

  it('builds the structured Eclipse lock object shell', () => {
    const xml = buildControlledLockObjectShellXml(input)
    expect(xml).toContain('adtcore:type="ENQU/DL"')
    expect(xml).toContain('<enqu:allowRFC>false</enqu:allowRFC>')
    expect(xml).toContain('<enqu:tableName>ZZIF_MCP_TEST</enqu:tableName>')
    expect(controlledLockObjectUrl(input.name)).toBe('/sap/bc/adt/ddic/lockobjects/sources/zzenqchk')
  })

  it('parses the validation check result', async () => {
    const client = { request: jest.fn().mockResolvedValue({ body: '<DATA><CHECK_RESULT>X</CHECK_RESULT></DATA>' }) }
    await expect(validateControlledLockObjectShell(client as never, input)).resolves.toEqual({ success: true })
    expect(client.request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: { Accept: 'application/vnd.sap.as+xml' }
    }))
  })

  it('requires canonical creation identity', async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        status: 201,
        headers: { location: '/sap/bc/adt/ddic/lockobjects/sources/zzenqchk' },
        body: '<enqu:lockobject xmlns:enqu="http://www.sap.com/adt/ddic/enqu" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZENQCHK" adtcore:type="ENQU/DL"><adtcore:packageRef adtcore:name="Z001"/><enqu:content><enqu:primaryTable><enqu:tableName>ZZIF_MCP_TEST</enqu:tableName></enqu:primaryTable></enqu:content></enqu:lockobject>'
      })
    }
    await expect(createControlledLockObjectShell(client as never, input, 'application/vnd.sap.adt.lockobjects.v1+xml')).resolves.toMatchObject({
      location: '/sap/bc/adt/ddic/lockobjects/sources/zzenqchk', lockObject: { name: 'ZZENQCHK', packageName: 'Z001', primaryTable: 'ZZIF_MCP_TEST' }
    })
  })

  it('parses the primary table from the object XML', () => {
    expect(parseControlledLockObject('<enqu:lockobject adtcore:name="ZZENQCHK" adtcore:type="ENQU/DL"><adtcore:packageRef adtcore:name="Z001"/><enqu:primaryTable><enqu:tableName>ZZIF_MCP_TEST</enqu:tableName></enqu:primaryTable></enqu:lockobject>')).toMatchObject({ name: 'ZZENQCHK', primaryTable: 'ZZIF_MCP_TEST' })
  })
})
