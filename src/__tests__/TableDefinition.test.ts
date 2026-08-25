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
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'CURRENCY' }, { name: 'CURRENCY', type: 'WAERS' }] }, 'must appear before'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'TEXT', type: 'CHAR', length: 5 }, { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'TEXT' }] }, 'incompatible'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'BAD', type: 'CHAR', length: 0 }] }, 'between 1 and 1333'],
    [{ name: 'ZTEST', description: 'Test', fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }, { name: 'BAD', type: 'CURR', length: 10, decimals: 10, referenceField: 'CLIENT' }] }, 'smaller than']
  ] as const)('rejects invalid table definition %#', (input, message) => {
    expect(() => buildDatabaseTableDdl(input as any)).toThrow(message)
  })

  it('supports the bounded fixed and parameterized built-in families', () => {
    const fixed = ['LANG', 'CUKY', 'UNIT', 'DATS', 'TIMS', 'ACCP', 'FLTP', 'INT1', 'INT2', 'INT4', 'INT8', 'DECFLOAT16', 'DECFLOAT34', 'UTCLONG']
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
  })
})
