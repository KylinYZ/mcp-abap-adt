import {
  buildControlledTypeGroupShellXml,
  controlledTypeGroupSourceUrl,
  controlledTypeGroupUrl,
  createControlledTypeGroupShell,
  parseControlledTypeGroup,
  validateControlledTypeGroupShell
} from '../typeGroupCreation'

describe('type group creation API', () => {
  const input = {
    name: 'ZZTG1', description: 'MCP type group', packageName: 'Z001', transportRequest: 'S4HK900009',
    language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  }

  it('builds the ADT 3.60.2 shell and canonical URLs', () => {
    expect(buildControlledTypeGroupShellXml(input)).toContain('<atypgr:abapTypeGroup')
    expect(buildControlledTypeGroupShellXml(input)).toContain('adtcore:type="TYPE/DG"')
    expect(controlledTypeGroupUrl('ZZTG1')).toBe('/sap/bc/adt/ddic/typegroups/zztg1')
    expect(controlledTypeGroupSourceUrl('ZZTG1')).toBe('/sap/bc/adt/ddic/typegroups/zztg1/source/main')
  })

  it('treats the target empty validation response as success', async () => {
    const client = { request: jest.fn().mockResolvedValue({ body: '', status: 200, headers: {} }) }
    await expect(validateControlledTypeGroupShell(client as never, input)).resolves.toEqual({ success: true })
    expect(client.request).toHaveBeenCalledWith('/sap/bc/adt/ddic/typegroups/validation', expect.objectContaining({
      qs: expect.objectContaining({ objtype: 'TYPE/DG', packagename: 'Z001' })
    }))
  })

  it('requires HTTP 201 and the canonical response identity', async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        status: 201,
        headers: { location: '/sap/bc/adt/ddic/typegroups/zztg1' },
        body: '<atypgr:abapTypeGroup xmlns:atypgr="http://www.sap.com/adt/ddic/typegroups" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZZTG1" adtcore:type="TYPE/DG"><adtcore:packageRef adtcore:name="Z001"/></atypgr:abapTypeGroup>'
      })
    }
    await expect(createControlledTypeGroupShell(client as never, input, 'application/vnd.sap.adt.ddic.typegroups.v2+xml')).resolves.toMatchObject({
      location: '/sap/bc/adt/ddic/typegroups/zztg1', typeGroup: { name: 'ZZTG1', packageName: 'Z001' }
    })
  })

  it('accepts an empty shell response when HTTP 201 has canonical Location', async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        status: 201,
        headers: { location: '/sap/bc/adt/ddic/typegroups/zztg1' },
        body: ''
      })
    }
    await expect(createControlledTypeGroupShell(client as never, input, 'application/vnd.sap.adt.ddic.typegroups.v2+xml')).resolves.toEqual({
      location: '/sap/bc/adt/ddic/typegroups/zztg1', typeGroup: { name: 'ZZTG1' }
    })
  })

  it('accepts an absolute canonical Location with query and trailing slash', async () => {
    const location = 'https://dev.example.test/SAP/BC/ADT/DDIC/TYPEGROUPS/ZZTG1/?sap-client=300'
    const client = {
      request: jest.fn().mockResolvedValue({ status: 201, headers: { location }, body: '' })
    }
    await expect(createControlledTypeGroupShell(client as never, input, 'application/vnd.sap.adt.ddic.typegroups.v2+xml')).resolves.toEqual({
      location, typeGroup: { name: 'ZZTG1' }
    })
  })

  it('parses source URI from the type group identity document', () => {
    expect(parseControlledTypeGroup('<atypgr:abapTypeGroup adtcore:name="ABAP" adtcore:type="TYPE/DG" abapsource:sourceUri="source/main"><adtcore:packageRef adtcore:name="SABAPDEMOS"/></atypgr:abapTypeGroup>')).toEqual({
      name: 'ABAP', packageName: 'SABAPDEMOS', sourceUri: 'source/main'
    })
  })
})
