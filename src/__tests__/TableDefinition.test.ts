import { buildDatabaseTableDdl } from '../safe/tableDefinition'

describe('controlled database table DDL', () => {
  it('renders fixed safety annotations, built-ins, data elements, CURR and QUAN references', () => {
    const ddl = buildDatabaseTableDdl({
      name: 'ZZIF_MCP_TEST',
      description: "MCP测试'表",
      fields: [
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'CURRENCY', type: 'WAERS' },
        { name: 'UNIT', type: 'MEINS' },
        { name: 'TEXT', type: 'CHAR', length: 40 },
        { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'CURRENCY' },
        { name: 'QUANTITY', type: 'QUAN', length: 13, decimals: 3, referenceField: 'UNIT' }
      ]
    })

    expect(ddl).toContain("@EndUserText.label : 'MCP测试''表'")
    expect(ddl).toContain('@AbapCatalog.tableCategory : #TRANSPARENT')
    expect(ddl).toContain('key client : abap.clnt not null;')
    expect(ddl).toContain('currency : waers;')
    expect(ddl).toContain('text : abap.char(40);')
    expect(ddl).toContain("@Semantics.amount.currencyCode : 'zzif_mcp_test.currency'")
    expect(ddl).toContain('amount : abap.curr(15,2);')
    expect(ddl).toContain("@Semantics.quantity.unitOfMeasure : 'zzif_mcp_test.unit'")
    expect(ddl).toContain('quantity : abap.quan(13,3);')
  })

  it.each([
    [{ name: 'ZTEST', description: 'Test', fields: [] }, 'between one and 500'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'FIELD', type: 'CHAR', length: 10 }] }, 'at least one key'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'CLIENT', type: 'CHAR', length: 1 }] }, 'Duplicate'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2 }] }, 'requires referenceField'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'CURRENCY' }] }, 'does not exist'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'TEXT', type: 'CHAR', length: 5 }, { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'TEXT' }] }, 'incompatible'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'BAD', type: 'CHAR', length: 0 }] }, 'between 1 and 1333'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'BAD', type: 'CURR', length: 10, decimals: 10, referenceField: 'CLIENT' }] }, 'smaller than']
  ] as const)('rejects invalid table definition %#', (input, message) => {
    expect(() => buildDatabaseTableDdl(input as any)).toThrow(message)
  })

  it('supports the bounded fixed and parameterized built-in families', () => {
    // CUKY/UNIT 不在此列——真机实证裸 abap.cuky/abap.unit 激活失败，映射为数据元素（见下个用例）
    const fixed = ['LANG', 'DATS', 'TIMS', 'ACCP', 'FLTP', 'INT1', 'INT2', 'INT4', 'INT8', 'DECFLOAT16', 'DECFLOAT34', 'UTCLONG']
    const fields = [
      { name: 'CLIENT', key: true, type: 'CLNT' },
      ...fixed.map((type, index) => ({ name: `F${index}`, type })),
      { name: 'CHAR_FIELD', type: 'CHAR', length: 10 },
      { name: 'NUMC_FIELD', type: 'NUMC', length: 8 },
      { name: 'RAW_FIELD', type: 'RAW', length: 16 },
      { name: 'SSTRING_FIELD', type: 'SSTRING', length: 100 },
      { name: 'DEC_FIELD', type: 'DEC', length: 15, decimals: 3 }
    ]
    const ddl = buildDatabaseTableDdl({ name: 'ZBUILTIN', description: 'Built-ins', fields })
    for (const type of fixed) expect(ddl).toContain(`abap.${type.toLowerCase()}`)
    expect(ddl).toContain('abap.dec(15,3)')
    expect(ddl).not.toContain('abap.cuky')
    expect(ddl).not.toContain('abap.unit')
  })

  it('maps CUKY/UNIT to the proven waers/meins data elements (A5 real-machine finding)', () => {
    // Basis 816 实证：裸 abap.unit 激活报 "位置的数量 < 数据类型最小数量 (UNIT)"；
    // 此前成功的 ZTABDATA_DEMO 用 waers/meins 数据元素——生成时改用已验证形态。
    const ddl = buildDatabaseTableDdl({
      name: 'ZCUKYUNT',
      description: 'Cuky unit mapping',
      fields: [
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'CURRENCY', type: 'CUKY' },
        { name: 'AMOUNT', type: 'CURR', length: 13, decimals: 2, referenceField: 'CURRENCY' },
        { name: 'UNITQ', type: 'UNIT' },
        { name: 'QTY', type: 'QUAN', length: 13, decimals: 3, referenceField: 'UNITQ' }
      ]
    })
    expect(ddl).toContain('currency : waers;')
    expect(ddl).toContain('unitq : meins;')
    expect(ddl).not.toContain('abap.cuky')
    expect(ddl).not.toContain('abap.unit')
    // CURR/QUAN 的语义注解与引用校验不受影响
    expect(ddl).toContain("@Semantics.amount.currencyCode : 'zcukyunt.currency'")
    expect(ddl).toContain("@Semantics.quantity.unitOfMeasure : 'zcukyunt.unitq'")
  })

  // ---------------------------------------------------------------------------
  // A5 交接修复回归：真机部署 ZTABDATA 双系统实战踩中的四类 DDIC 创建协议缺陷
  // ---------------------------------------------------------------------------

  it('maps STRING (no length) to the verified abap.sstring(255) and sstring(n) (with length)', () => {
    const ddl = buildDatabaseTableDdl({
      name: 'ZSTRINGT',
      description: 'String fields',
      fields: [
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'LONGTEXT', type: 'STRING' },
        { name: 'NAME', type: 'SSTRING', length: 80 }
      ]
    })
    // 真机两次实证：透明表裸 abap.string 激活失败/激活后源码规范化致 verify 失败；
    // ZTABDATA_DEMO 用 abap.sstring(255) 全链通过——无 length 按 255 生成。
    expect(ddl).toContain('longtext : abap.sstring(255);')
    expect(ddl).toContain('name : abap.sstring(80);')
    expect(ddl).not.toMatch(/longtext : (string|abap\.string);/)
  })

  it.each([
    [{ name: 'CREATED', type: 'DATS', decimals: 0 }],
    [{ name: 'CLIENT', key: true, type: 'CLNT', length: 3 }],
    [{ name: 'LONGTEXT', type: 'STRING', decimals: 0 }]
  ] as const)('rejects dimension parameters on types that do not take them %#', field => {
    const input = field.type === 'STRING'
      ? { name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, field as any] }
      : { name: 'ZTEST', description: 'Test', fields: [field as any] }
    expect(() => buildDatabaseTableDdl(input as any)).toThrow()
  })

  it('rejects fixed-length types carrying length with an actionable message', () => {
    expect(() => buildDatabaseTableDdl({
      name: 'ZTEST',
      description: 'Test',
      fields: [{ name: 'CLIENT', key: true, type: 'CLNT', length: 3 }]
    })).toThrow('fixed-length type: omit length and decimals entirely')
  })

  it('tells DEC+referenceField callers to use CURR or QUAN', () => {
    expect(() => buildDatabaseTableDdl({
      name: 'ZTEST',
      description: 'Test',
      fields: [
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'CURRENCY', type: 'CUKY' },
        { name: 'AMOUNT', type: 'DEC', length: 15, decimals: 2, referenceField: 'CURRENCY' }
      ]
    })).toThrow('must use type CURR or QUAN instead of DEC')
  })

  it('reorders a referenced field declared after its CURR consumer (A5: automatic dependency order)', () => {
    // 真机踩坑：referenceField 必须先于引用字段，顺序错报 "must appear before"——现在自动重排
    const ddl = buildDatabaseTableDdl({
      name: 'ZREORDR',
      description: 'Reorder',
      fields: [
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'CURRENCY' },
        { name: 'CURRENCY', type: 'CUKY' }
      ]
    })
    const currencyLine = ddl.indexOf('currency : waers;')
    const amountLine = ddl.indexOf('amount : abap.curr(15,2);')
    expect(currencyLine).toBeGreaterThan(-1)
    expect(amountLine).toBeGreaterThan(-1)
    // 引用字段被自动移动到引用者之前
    expect(currencyLine).toBeLessThan(amountLine)
    expect(ddl).toContain("@Semantics.amount.currencyCode : 'zreordr.currency'")
  })

  it('keeps the key prefix contiguous while reordering', () => {
    // key 字段重排后必须仍构成连续前缀：key 组整体在前
    const ddl = buildDatabaseTableDdl({
      name: 'ZKEYPRE',
      description: 'Key prefix',
      fields: [
        { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'CURRENCY' },
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'KEYCURR', key: true, type: 'CURR', length: 12, decimals: 2, referenceField: 'WAERSC' },
        { name: 'CURRENCY', type: 'CUKY' },
        { name: 'WAERSC', key: true, type: 'CUKY' }
      ]
    })
    // key 字段（client/keycurr/waersc）全部出现在非 key 字段（amount/currency）之前
    const keyEnd = Math.max(
      ddl.indexOf('key client : abap.clnt'),
      ddl.indexOf('key keycurr : abap.curr(12,2)'),
      ddl.indexOf('key waersc : waers')
    )
    const nonKeyStart = Math.min(
      ddl.indexOf('amount : abap.curr(15,2)'),
      ddl.indexOf('currency : waers;')
    )
    expect(keyEnd).toBeLessThan(nonKeyStart)
  })

  it('still refuses a key CURR referencing a non-key field (key prefix cannot be broken)', () => {
    // key 的 CURR 引用非 key 的 CUKY 无法通过重排满足（key 必须在前缀）——保留明确报错
    expect(() => buildDatabaseTableDdl({
      name: 'ZTEST',
      description: 'Test',
      fields: [
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'KEYCURR', key: true, type: 'CURR', length: 12, decimals: 2, referenceField: 'CURRENCY' },
        { name: 'CURRENCY', type: 'CUKY' }
      ]
    })).toThrow('must appear before')
  })
})
