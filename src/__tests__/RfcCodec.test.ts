/**
 * RFC 基础类型编解码测试（对应 src/rfc/codec.ts + types.ts）。
 *
 * 覆盖：每种基础类型的 encode→decode 往返（含空串、最大/最小值、负数）、
 * 非法输入报错、结构与内表（含嵌套）往返、缓冲区不足与环引用防御。
 * 全部为纯内存操作，无任何网络 IO。
 */

import { decodeRfcValue, encodeRfcValue } from '../rfc/codec';
import { RfcError } from '../rfc/errors';
import {
  bcd,
  char,
  fixedByteLength,
  numc,
  RFC_DATE,
  RFC_FLOAT,
  RFC_INT,
  RFC_INT8,
  RFC_STRING,
  RFC_TIME,
  RFC_XSTRING,
  structure,
  table,
  validateRfcTypeSpec,
  RfcTypeSpec
} from '../rfc/types';

/** 断言「编码并解码」往返后回到期望的规范化值。 */
function roundtrip(spec: RfcTypeSpec, value: unknown, expected: unknown): void {
  const bytes = encodeRfcValue(spec, value);
  const decoded = decodeRfcValue(spec, bytes);
  expect(decoded.bytesRead).toBe(bytes.length);
  expect(decoded.value).toEqual(expected);
}

/** 断言编码/解码抛出 RFC_CODEC_ERROR。 */
function expectCodecError(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected an RFC_CODEC_ERROR');
  } catch (error) {
    if (!(error instanceof RfcError)) throw error;
    expect(error.code).toBe('RFC_CODEC_ERROR');
  }
}

describe('RfcCodec primitives', () => {
  describe('CHAR', () => {
    it('roundtrips with left-aligned space padding', () => {
      // 'AB' 在 CHAR(4) 中左对齐，右侧补空格：0x41 0x42 0x20 0x20。
      const bytes = encodeRfcValue(char(4), 'AB');
      expect([...bytes]).toEqual([0x41, 0x42, 0x20, 0x20]);
      // 解码按 ABAP 语义去掉尾随空格，往返得到原始值。
      roundtrip(char(4), 'AB', 'AB');
    });

    it('encodes empty string as all spaces and roundtrips to empty', () => {
      roundtrip(char(3), '', '');
      expect([...encodeRfcValue(char(3), '')]).toEqual([0x20, 0x20, 0x20]);
    });

    it('keeps leading spaces significant', () => {
      roundtrip(char(4), ' AB', ' AB');
    });

    it('accepts full-length latin-1 values', () => {
      roundtrip(char(3), 'abc', 'abc');
    });

    it('rejects overlong values', () => {
      expectCodecError(() => encodeRfcValue(char(2), 'ABC'));
    });

    it('rejects characters outside latin-1', () => {
      expectCodecError(() => encodeRfcValue(char(4), '中文'));
    });

    it('rejects non-string values', () => {
      expectCodecError(() => encodeRfcValue(char(4), 42));
    });
  });

  describe('NUMC', () => {
    it('roundtrips with right-aligned zero padding', () => {
      // '42' 在 NUMC(4) 中右对齐，左侧补零：'0042'。
      const bytes = encodeRfcValue(numc(4), '42');
      expect(bytes.toString('latin1')).toBe('0042');
      roundtrip(numc(4), '42', '42');
    });

    it('roundtrips zero to canonical single zero', () => {
      roundtrip(numc(4), '0', '0');
    });

    it('roundtrips the maximum digit count', () => {
      roundtrip(numc(8), '99999999', '99999999');
    });

    it('rejects non-digit input', () => {
      expectCodecError(() => encodeRfcValue(numc(4), '12a4'));
    });

    it('rejects overlong digit strings', () => {
      expectCodecError(() => encodeRfcValue(numc(4), '12345'));
    });
  });

  describe('INT', () => {
    it('roundtrips boundaries in 4 big-endian bytes', () => {
      expect(encodeRfcValue(RFC_INT, 0).length).toBe(4);
      expect([...encodeRfcValue(RFC_INT, 2147483647)][0]).toBe(0x7f);
      expect([...encodeRfcValue(RFC_INT, -2147483648)][0]).toBe(0x80);
      roundtrip(RFC_INT, 0, 0);
      roundtrip(RFC_INT, 2147483647, 2147483647);
      roundtrip(RFC_INT, -2147483648, -2147483648);
      roundtrip(RFC_INT, -1, -1);
    });

    it('rejects non-integers and out-of-range values', () => {
      expectCodecError(() => encodeRfcValue(RFC_INT, 1.5));
      expectCodecError(() => encodeRfcValue(RFC_INT, 2147483648));
      expectCodecError(() => encodeRfcValue(RFC_INT, '5'));
    });
  });

  describe('INT8', () => {
    it('roundtrips boundaries in 8 big-endian bytes', () => {
      expect(encodeRfcValue(RFC_INT8, BigInt(0)).length).toBe(8);
      roundtrip(RFC_INT8, BigInt('9223372036854775807'), BigInt('9223372036854775807'));
      roundtrip(RFC_INT8, BigInt('-9223372036854775808'), BigInt('-9223372036854775808'));
      roundtrip(RFC_INT8, BigInt(-1), BigInt(-1));
    });

    it('accepts safe integers and decimal strings', () => {
      roundtrip(RFC_INT8, 1234567890, BigInt(1234567890));
      roundtrip(RFC_INT8, '9007199254740993', BigInt('9007199254740993')); // 超出 2^53，只能用字符串/bigint
    });

    it('rejects out-of-range and malformed input', () => {
      expectCodecError(() => encodeRfcValue(RFC_INT8, BigInt('9223372036854775808')));
      expectCodecError(() => encodeRfcValue(RFC_INT8, 1.5));
      expectCodecError(() => encodeRfcValue(RFC_INT8, '12x'));
    });
  });

  describe('FLOAT', () => {
    it('roundtrips IEEE-754 doubles in 8 bytes', () => {
      expect(encodeRfcValue(RFC_FLOAT, 0).length).toBe(8);
      roundtrip(RFC_FLOAT, 3.14159, 3.14159);
      roundtrip(RFC_FLOAT, -2.5e-10, -2.5e-10);
      roundtrip(RFC_FLOAT, 0, 0);
    });

    it('rejects NaN, Infinity and non-numbers', () => {
      expectCodecError(() => encodeRfcValue(RFC_FLOAT, Number.NaN));
      expectCodecError(() => encodeRfcValue(RFC_FLOAT, Number.POSITIVE_INFINITY));
      expectCodecError(() => encodeRfcValue(RFC_FLOAT, '1.5'));
    });
  });

  describe('DATE', () => {
    it('roundtrips yyyymmdd text', () => {
      expect(encodeRfcValue(RFC_DATE, '20260916').toString('latin1')).toBe('20260916');
      roundtrip(RFC_DATE, '20260916', '20260916');
    });

    it('accepts leap day in a leap year', () => {
      roundtrip(RFC_DATE, '20240229', '20240229');
    });

    it('rejects impossible dates and malformed text', () => {
      expectCodecError(() => encodeRfcValue(RFC_DATE, '20230229')); // 平年 2 月 29 日
      expectCodecError(() => encodeRfcValue(RFC_DATE, '20261301')); // 13 月
      expectCodecError(() => encodeRfcValue(RFC_DATE, '2026091')); // 7 位
      expectCodecError(() => encodeRfcValue(RFC_DATE, 20260916)); // 非字符串
    });
  });

  describe('TIME', () => {
    it('roundtrips hhmmss text', () => {
      roundtrip(RFC_TIME, '235959', '235959');
      roundtrip(RFC_TIME, '000000', '000000');
    });

    it('rejects out-of-range fields', () => {
      expectCodecError(() => encodeRfcValue(RFC_TIME, '240000')); // 24 时
      expectCodecError(() => encodeRfcValue(RFC_TIME, '125960')); // 60 秒
      expectCodecError(() => encodeRfcValue(RFC_TIME, '12000')); // 5 位
    });
  });

  describe('STRING', () => {
    it('roundtrips empty and unicode strings', () => {
      // 空串：4 字节大端长度前缀 0。
      expect([...encodeRfcValue(RFC_STRING, '')]).toEqual([0, 0, 0, 0]);
      roundtrip(RFC_STRING, '', '');
      roundtrip(RFC_STRING, '中文AB测试', '中文AB测试');
    });

    it('rejects non-string values', () => {
      expectCodecError(() => encodeRfcValue(RFC_STRING, 123));
    });
  });

  describe('XSTRING', () => {
    it('roundtrips raw bytes including 0x00 and 0xff', () => {
      const payload = Buffer.from([0x00, 0xff, 0x80, 0x01]);
      roundtrip(RFC_XSTRING, payload, Buffer.from(payload));
      roundtrip(RFC_XSTRING, new Uint8Array(0), Buffer.alloc(0));
    });

    it('rejects non-byte values', () => {
      expectCodecError(() => encodeRfcValue(RFC_XSTRING, 'raw'));
    });
  });

  describe('BCD', () => {
    it('packs two digits per byte with sign nibble', () => {
      // bcd(3,2) 容量 5 位：'123.45' → 0x12 0x34 0x5C（最后半字节 0xC = 正）。
      expect([...encodeRfcValue(bcd(3, 2), '123.45')]).toEqual([0x12, 0x34, 0x5c]);
      roundtrip(bcd(3, 2), '123.45', '123.45');
    });

    it('encodes negative values with sign nibble 0xD', () => {
      // '-12.34' → 数字 01234 + 符号 D：0x01 0x23 0x4D。
      expect([...encodeRfcValue(bcd(3, 2), '-12.34')]).toEqual([0x01, 0x23, 0x4d]);
      roundtrip(bcd(3, 2), '-12.34', '-12.34');
    });

    it('roundtrips zero and accepts numbers', () => {
      roundtrip(bcd(3, 2), '0.00', '0.00');
      roundtrip(bcd(3, 2), 12.34, '12.34');
      roundtrip(bcd(2, 0), '-42', '-42'); // 无小数位
    });

    it('rejects fraction overflow, capacity overflow and garbage', () => {
      expectCodecError(() => encodeRfcValue(bcd(3, 2), '1.234')); // 小数 3 位 > decimals 2
      expectCodecError(() => encodeRfcValue(bcd(3, 2), '12345.67')); // 7 位 > 容量 5
      expectCodecError(() => encodeRfcValue(bcd(3, 2), 'abc'));
      expectCodecError(() => encodeRfcValue(bcd(3, 2), Number.NaN));
    });

    it('rejects invalid packed bytes while decoding', () => {
      // 非法符号半字节 0x1（应属数字位以外的符号集合）。
      expectCodecError(() => decodeRfcValue(bcd(2, 0), Buffer.from([0x12, 0x31])));
      // 数字位出现 0xA（>9）。
      expectCodecError(() => decodeRfcValue(bcd(2, 0), Buffer.from([0xa2, 0x3c])));
    });
  });
});

describe('RfcCodec structures and tables', () => {
  /** 被测嵌套规格：结构体含定长字段、嵌套结构体与内表。 */
  const nestedSpec = structure([
    { name: 'MANDT', type: char(3) },
    { name: 'CORE', type: structure([{ name: 'COUNT', type: RFC_INT }, { name: 'CODE', type: numc(3) }]) },
    { name: 'TAGS', type: table(char(2)) },
    { name: 'AMOUNT', type: bcd(3, 2) }
  ]);

  it('roundtrips a nested structure with an embedded table', () => {
    const value = {
      MANDT: '100',
      CORE: { COUNT: -7, CODE: '42' },
      TAGS: ['ab', 'x', ''],
      AMOUNT: '-1.25'
    };
    const bytes = encodeRfcValue(nestedSpec, value);
    roundtrip(nestedSpec, value, {
      MANDT: '100',
      CORE: { COUNT: -7, CODE: '42' },
      TAGS: ['ab', 'x', ''],
      AMOUNT: '-1.25'
    });
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('rejects missing fields', () => {
    expectCodecError(() => encodeRfcValue(nestedSpec, { MANDT: '100', CORE: { COUNT: 1, CODE: '1' }, TAGS: [] }));
  });

  it('rejects unknown fields', () => {
    expectCodecError(() =>
      encodeRfcValue(nestedSpec, {
        MANDT: '100',
        CORE: { COUNT: 1, CODE: '1' },
        TAGS: [],
        AMOUNT: '0.00',
        EXTRA: 'nope'
      })
    );
  });

  it('rejects arrays or null as structure values', () => {
    expectCodecError(() => encodeRfcValue(nestedSpec, [] as unknown as Record<string, unknown>));
    expectCodecError(() => encodeRfcValue(nestedSpec, null));
  });

  it('roundtrips an empty table and a table of structures', () => {
    const tableOfStruct = table(structure([{ name: 'K', type: char(2) }, { name: 'V', type: RFC_INT }]));
    roundtrip(tableOfStruct, [], []);
    roundtrip(tableOfStruct, [{ K: 'a', V: 1 }, { K: 'b', V: -2 }], [{ K: 'a', V: 1 }, { K: 'b', V: -2 }]);
  });

  it('decodes fixed-length values from a shared buffer via offsets', () => {
    // 两个 INT 连续存放：模拟「结构体字段游标推进」的用法。
    const buffer = Buffer.concat([encodeRfcValue(RFC_INT, 1), encodeRfcValue(RFC_INT, -1)]);
    const first = decodeRfcValue(RFC_INT, buffer, 0);
    const second = decodeRfcValue(RFC_INT, buffer, first.bytesRead);
    expect(first.value).toBe(1);
    expect(second.value).toBe(-1);
    expect(second.bytesRead + first.bytesRead).toBe(buffer.length);
  });

  it('reports buffer underflow while decoding', () => {
    expectCodecError(() => decodeRfcValue(RFC_INT, Buffer.alloc(3)));
    // STRING 长度前缀声称 10 字节负载，实际只剩 4 字节。
    const lying = Buffer.concat([Buffer.from([0, 0, 0, 10]), Buffer.alloc(4)]);
    expectCodecError(() => decodeRfcValue(RFC_STRING, lying));
  });

  it('reports a lying table row count while decoding', () => {
    // 行数前缀为 1000，但缓冲区没有任何行字节。
    const lying = Buffer.from([0, 0, 3, 232]);
    expectCodecError(() => decodeRfcValue(table(char(4)), lying));
  });
});

describe('RfcCodec type validation', () => {
  it('computes fixed byte lengths for fixed-size specs', () => {
    expect(fixedByteLength(char(4))).toBe(4);
    expect(fixedByteLength(bcd(3, 2))).toBe(3);
    expect(fixedByteLength(structure([{ name: 'A', type: char(4) }, { name: 'B', type: RFC_INT }]))).toBe(8);
  });

  it('returns null for variable-length specs', () => {
    expect(fixedByteLength(RFC_STRING)).toBeNull();
    expect(fixedByteLength(RFC_XSTRING)).toBeNull();
    expect(fixedByteLength(table(char(4)))).toBeNull();
    expect(fixedByteLength(structure([{ name: 'A', type: char(4) }, { name: 'S', type: RFC_STRING }]))).toBeNull();
  });

  it('rejects duplicate or invalid field names', () => {
    expectCodecError(() =>
      validateRfcTypeSpec(structure([{ name: 'A', type: RFC_INT }, { name: 'A', type: RFC_INT }]))
    );
    expectCodecError(() => validateRfcTypeSpec(structure([{ name: '1A', type: RFC_INT }])));
  });

  it('rejects cyclic type specs instead of recursing forever', () => {
    // 构造环引用：结构体在自身字段里引用自己。
    const cyclic = { kind: 'STRUCTURE', fields: [] as unknown[] } as unknown as RfcTypeSpec;
    (cyclic as unknown as { fields: unknown[] }).fields.push({ name: 'SELF', type: cyclic });
    expectCodecError(() => encodeRfcValue(cyclic, {}));
  });
});
