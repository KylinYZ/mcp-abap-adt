import {
  type AdtHTTP,
  buildControlledPackageXml,
  createControlledPackage,
  getControlledPackageConstraints,
  parseControlledPackage,
  validateControlledPackage
} from '../adt/index.js'

const input = {
  name: 'ZIFLOG_CORE', description: '接口日志核心服务', parentPackageName: 'ZIFLOG',
  softwareComponent: 'HOME', transportLayer: 'SAP', transportRequest: 'S4HK900013',
  language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
}

function http(response: Partial<{ body: string; status: number; headers: Record<string, string> }> = {}) {
  return {
    request: jest.fn().mockResolvedValue({ body: '', status: 200, statusText: 'OK', headers: {}, ...response })
  } as unknown as AdtHTTP
}

describe('controlled package ADT contract', () => {
  it('uses exact basic and full validation query names', async () => {
    const client = http({ body: '<asx:abap><asx:values><DATA><SEVERITY>S</SEVERITY><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>' })
    await validateControlledPackage(client, input, 'basic')
    await validateControlledPackage(client, input, 'full')

    expect((client.request as jest.Mock).mock.calls[0]).toEqual([
      '/sap/bc/adt/packages/validation', expect.objectContaining({
        method: 'POST',
        qs: { objname: 'ZIFLOG_CORE', packagename: 'ZIFLOG', description: '接口日志核心服务', packagetype: 'development', checkmode: 'basic' },
        headers: { Accept: 'application/vnd.sap.as+xml' }
      })
    ])
    expect((client.request as jest.Mock).mock.calls[1][1].qs).toEqual({
      objname: 'ZIFLOG_CORE', packagename: 'ZIFLOG', description: '接口日志核心服务',
      packagetype: 'development', checkmode: 'full', swcomp: 'HOME', transportlayer: 'SAP', recordChanges: true
    })
    expect((client.request as jest.Mock).mock.calls[1][1].qs).not.toHaveProperty('transportLayer')
  })

  it('reads software-component and package constraints with separate discovery media types', async () => {
    const client = http({ body: '{"constraint":true}' })
    await expect(getControlledPackageConstraints(client, input)).resolves.toBe('{"constraint":true}')
    expect((client.request as jest.Mock).mock.calls).toEqual([
      ['/sap/bc/adt/packages/$constraints', expect.objectContaining({
        headers: { Accept: 'application/softwareComponent.v1+json' }
      })],
      ['/sap/bc/adt/packages/$constraints', expect.objectContaining({
        headers: { Accept: 'application/packageConstraints.v1+json' }
      })]
    ])
  })

  it('builds the captured V2 package XML without hard-coded package identities', () => {
    const xml = buildControlledPackageXml(input)
    expect(xml).toContain('adtcore:name="ZIFLOG_CORE"')
    expect(xml).toContain('<adtcore:packageRef adtcore:name="ZIFLOG_CORE"/>')
    expect(xml).toContain('<pak:superPackage adtcore:name="ZIFLOG"/>')
    expect(xml).toContain('pak:isEncapsulated="true"')
    expect(xml).toContain('pak:recordChanges="true"')
    expect(xml).toContain('pak:name="HOME"')
    expect(xml).toContain('pak:name="SAP"')
    expect(xml).not.toContain('YMU_RAP')
  })

  it('requires HTTP 201, Location, and matching response identity', async () => {
    const body = buildControlledPackageXml(input)
    const client = http({ body, status: 201, headers: { location: '/sap/bc/adt/packages/ziflog_core' } })
    await expect(createControlledPackage(client, input)).resolves.toMatchObject({
      location: '/sap/bc/adt/packages/ziflog_core',
      package: { name: 'ZIFLOG_CORE', parentPackageName: 'ZIFLOG', softwareComponent: 'HOME', transportLayer: 'SAP' }
    })
    expect((client.request as jest.Mock).mock.calls[0]).toEqual([
      '/sap/bc/adt/packages', expect.objectContaining({
        method: 'POST', qs: { corrNr: 'S4HK900013' },
        headers: {
          'Content-Type': 'application/vnd.sap.adt.packages.v2+xml',
          Accept: 'application/vnd.sap.adt.packages.v2+xml, application/vnd.sap.adt.packages.v1+xml'
        }
      })
    ])

    await expect(createControlledPackage(http({ body, status: 201, headers: {} }), input)).rejects.toThrow('Location')
    await expect(createControlledPackage(http({ body: body.replace(/ZIFLOG_CORE/g, 'ZOTHER'), status: 201, headers: { location: '/x' } }), input))
      .rejects.toThrow('identity')
  })

  it('parses the fixed package attributes used for post-create verification', () => {
    expect(parseControlledPackage(buildControlledPackageXml(input))).toEqual({
      name: 'ZIFLOG_CORE', description: '接口日志核心服务', parentPackageName: 'ZIFLOG',
      language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157',
      softwareComponent: 'HOME', transportLayer: 'SAP', packageType: 'development',
      isEncapsulated: true, recordChanges: true
    })
  })
})
