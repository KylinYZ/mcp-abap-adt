/**
 * FM 接口描述模型测试（对应 src/rfc/interface.ts）。
 *
 * 覆盖：接口描述校验（方向/重名/类型规格）、JSON Schema 生成（输入与输出
 * 视角）、入参 payload 校验器（必填/未知字段/类型形状/嵌套）。
 * 全部为纯内存操作，无任何网络 IO。
 */

import {
  FmInterfaceDescription,
  fmInterfaceToJsonSchema,
  validateFmCallPayload,
  validateFmInterface
} from '../rfc/interface';
import { RfcError } from '../rfc/errors';
import {
  bcd,
  char,
  numc,
  RFC_DATE,
  RFC_INT,
  RFC_INT8,
  RFC_STRING,
  RfcTypeSpec,
  structure,
  table
} from '../rfc/types';

/** 被测接口：一个典型的只读查询 FM 签名。 */
function sampleInterface(): FmInterfaceDescription {
  return {
    name: 'Z_RFCSPIKE_READ',
    parameters: [
      { name: 'IV_ID', direction: 'IMPORTING', type: char(10) }, // 必填
      { name: 'IV_COUNT', direction: 'IMPORTING', type: RFC_INT, optional: true }, // 可选
      { name: 'IV_KEYDATE', direction: 'IMPORTING', type: RFC_DATE, optional: true },
      { name: 'CV_FLAG', direction: 'CHANGING', type: char(1) }, // 必填
      { name: 'EV_NAME', direction: 'EXPORTING', type: char(20) },
      { name: 'EV_AMOUNT', direction: 'EXPORTING', type: bcd(5, 2) },
      { name: 'TT_ROWS', direction: 'TABLES', type: table(structure([{ name: 'LINE', type: RFC_STRING }])), optional: true }
    ],
    exceptions: [{ name: 'NOT_FOUND' }, { name: 'LOCKED', number: 8 }]
  };
}

describe('RfcInterface validation', () => {
  it('accepts a well-formed interface description', () => {
    expect(() => validateFmInterface(sampleInterface())).not.toThrow();
  });

  it('rejects invalid FM names', () => {
    const broken = { ...sampleInterface(), name: '1_BAD NAME' };
    expect(() => validateFmInterface(broken)).toThrow(RfcError);
  });

  it('rejects duplicate parameter names', () => {
    const broken = {
      ...sampleInterface(),
      parameters: [...sampleInterface().parameters, { name: 'IV_ID', direction: 'EXPORTING' as const, type: RFC_INT }]
    };
    expect(() => validateFmInterface(broken)).toThrow(RfcError);
  });

  it('rejects unknown parameter directions', () => {
    const broken = {
      ...sampleInterface(),
      parameters: [{ name: 'IV_X', direction: 'RETURNING' as unknown as 'IMPORTING', type: RFC_INT }]
    };
    expect(() => validateFmInterface(broken)).toThrow(RfcError);
  });

  it('rejects interfaces with malformed type specs', () => {
    // length:0 的 CHAR 规格非法；以 unknown 断言注入故意坏掉的规格。
    const broken = {
      ...sampleInterface(),
      parameters: [{ name: 'IV_X', direction: 'IMPORTING' as const, type: { kind: 'CHAR', length: 0 } as unknown as RfcTypeSpec }]
    };
    expect(() => validateFmInterface(broken)).toThrow(RfcError);
  });
});

describe('RfcInterface JSON schema generation', () => {
  it('describes the input view (IMPORTING + CHANGING + TABLES)', () => {
    const schema = fmInterfaceToJsonSchema(sampleInterface(), 'input');
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['CV_FLAG', 'IV_COUNT', 'IV_ID', 'IV_KEYDATE', 'TT_ROWS']);
    // 必填 = 非 optional 的 IMPORTING/CHANGING；TABLES 与 optional 参数不进 required。
    expect(schema.required).toEqual(expect.arrayContaining(['IV_ID', 'CV_FLAG']));
    expect(schema.required).not.toContain('IV_COUNT');
    expect(schema.required).not.toContain('TT_ROWS');
    // TABLES 属性应为数组形态。
    expect(schema.properties?.TT_ROWS?.type).toBe('array');
    expect(schema.properties?.TT_ROWS?.items?.type).toBe('object');
  });

  it('describes the output view (EXPORTING + CHANGING + TABLES)', () => {
    const schema = fmInterfaceToJsonSchema(sampleInterface(), 'output');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['CV_FLAG', 'EV_AMOUNT', 'EV_NAME', 'TT_ROWS']);
    expect(schema.properties?.EV_AMOUNT?.type).toBe('string'); // BCD 以十进制字符串承载
  });

  it('maps primitive specs to JSON schema facets', () => {
    const schema = fmInterfaceToJsonSchema(sampleInterface(), 'input');
    expect(schema.properties?.IV_ID).toMatchObject({ type: 'string', maxLength: 10 });
    expect(schema.properties?.IV_COUNT).toMatchObject({ type: 'integer', minimum: -2147483648, maximum: 2147483647 });
    expect(schema.properties?.IV_KEYDATE).toMatchObject({ type: 'string', pattern: '^[0-9]{8}$' });
    // INT8 以 int64 format 标注（JSON number 无法完整表达 2^63）。
    const int8Schema = fmInterfaceToJsonSchema(
      { name: 'Z_I8', parameters: [{ name: 'IV_BIG', direction: 'IMPORTING', type: RFC_INT8 }], exceptions: [] },
      'input'
    );
    expect(int8Schema.properties?.IV_BIG).toMatchObject({ type: 'integer', format: 'int64' });
  });
});

describe('RfcInterface payload validation', () => {
  it('accepts a valid payload and returns a normalized copy', () => {
    const payload = { IV_ID: 'ABC123', CV_FLAG: 'X', IV_COUNT: 3, TT_ROWS: [{ LINE: 'row-1' }] };
    const result = validateFmCallPayload(sampleInterface(), payload);
    expect(result).toMatchObject({ ok: true, normalized: payload });
  });

  it('allows omitting optional parameters and TABLES', () => {
    const result = validateFmCallPayload(sampleInterface(), { IV_ID: 'X1', CV_FLAG: '' });
    expect(result.ok).toBe(true);
  });

  it('rejects missing required parameters with field names', () => {
    const result = validateFmCallPayload(sampleInterface(), { CV_FLAG: 'X' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('IV_ID'))).toBe(true);
    }
  });

  it('rejects unknown fields instead of ignoring them', () => {
    const result = validateFmCallPayload(sampleInterface(), { IV_ID: 'X', CV_FLAG: 'X', EV_NAME: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('EV_NAME'))).toBe(true);
    }
  });

  it('rejects payloads with wrong value shapes', () => {
    // INT 参数传浮点。
    const floatResult = validateFmCallPayload(sampleInterface(), { IV_ID: 'X', CV_FLAG: 'X', IV_COUNT: 1.5 });
    expect(floatResult.ok).toBe(false);
    // DATE 参数传非 8 位文本。
    const dateResult = validateFmCallPayload(sampleInterface(), { IV_ID: 'X', CV_FLAG: 'X', IV_KEYDATE: '2026-09-16' });
    expect(dateResult.ok).toBe(false);
    // CHAR 参数超长。
    const longResult = validateFmCallPayload(sampleInterface(), { IV_ID: '0123456789X', CV_FLAG: 'X' });
    expect(longResult.ok).toBe(false);
  });

  it('validates TABLES rows against the row type', () => {
    const result = validateFmCallPayload(sampleInterface(), { IV_ID: 'X', CV_FLAG: 'X', TT_ROWS: [{ WRONG: 1 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('TT_ROWS'))).toBe(true);
    }
  });

  it('rejects non-object payloads', () => {
    expect(validateFmCallPayload(sampleInterface(), null).ok).toBe(false);
    expect(validateFmCallPayload(sampleInterface(), [1, 2]).ok).toBe(false);
    expect(validateFmCallPayload(sampleInterface(), 'x').ok).toBe(false);
  });

  it('supports bigint values for INT8 parameters', () => {
    const desc: FmInterfaceDescription = {
      name: 'Z_I8_FM',
      parameters: [{ name: 'IV_BIG', direction: 'IMPORTING', type: RFC_INT8 }],
      exceptions: []
    };
    expect(validateFmCallPayload(desc, { IV_BIG: BigInt('9007199254740993') }).ok).toBe(true);
    expect(validateFmCallPayload(desc, { IV_BIG: 1.5 }).ok).toBe(false);
  });

  it('validates nested structure payloads', () => {
    const desc: FmInterfaceDescription = {
      name: 'Z_NESTED',
      parameters: [
        { name: 'IS_DATA', direction: 'IMPORTING', type: structure([{ name: 'CODE', type: numc(3) }, { name: 'TEXT', type: RFC_STRING }]) }
      ],
      exceptions: []
    };
    expect(validateFmCallPayload(desc, { IS_DATA: { CODE: '12', TEXT: 'ok' } }).ok).toBe(true);
    // 缺少结构体字段。
    expect(validateFmCallPayload(desc, { IS_DATA: { CODE: '12' } }).ok).toBe(false);
    // 结构体出现未知字段。
    expect(validateFmCallPayload(desc, { IS_DATA: { CODE: '12', TEXT: 'ok', EXTRA: 1 } }).ok).toBe(false);
  });
});
