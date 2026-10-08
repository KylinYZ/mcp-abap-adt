/**
 * ClusterDataDecoder 测试（VSP pkg/datacluster + pkg/sapcompress 全语义移植）。
 *
 * 全部向量离线合成（不复制 VSP fixtures 入库——来源审计决定，见
 * docs/evidence/fm-test-data-payload-spike.md）；开发时已用 Go oracle
 * （VSP 固定审计版本 9886d272 原样编译）对 7 个集群 fixtures + 12 组压缩
 * fixtures 做过逐字节/逐值恒等对照（结果见本轮证据文档）。
 * 压缩流构造器：LZH = node deflateSync 造 raw DEFLATE + 手工 SAP 前缀；
 * LZC = 最小 LZW 生成器（字面量/KwKwK/clear 三形态，按 compress(1) 的
 * "每 chunk 恰 8 码"怪癖打包）。
 */
import { deflateRawSync } from 'node:zlib';
import {
  parseCluster, joinFragments, decodeClusterHex, sapDecompress, parseSapCompressHeader,
  type ClusterObject
} from '../adt/ClusterDataDecoder';

/* ==========================================================================
 * 位/流构造工具
 * ========================================================================== */

/** 16 字节集群头：[0]=0xFF、[1]=版本、[4]=体格式、[8..11]=码页 ASCII。 */
function clusterHeader(version: number, format: number, codepage: string): number[] {
  const head = new Array<number>(16).fill(0);
  head[0] = 0xff;
  head[1] = version;
  head[4] = format;
  for (let i = 0; i < 4; i += 1) head[8 + i] = codepage.charCodeAt(i);
  return head;
}

/** u32 大端字节。 */
function u32be(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function u16be(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff];
}

/** 定长字符串的 ASCII 字节。 */
function asciiBytes(s: string): number[] {
  return [...s].map(ch => ch.charCodeAt(0));
}

/** UTF-16LE 字节（V6 对象名/字符数据用）。 */
function utf16le(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const unit = ch.codePointAt(0)!;
    out.push(unit & 0xff, (unit >> 8) & 0xff);
  }
  return out;
}

/** V6 对象头（32 字节 + UTF-16LE 名）。 */
function v6ObjectHeader(kind: number, typeCode: number, decimals: number, rowLength: number, size: number, name: string): number[] {
  const head = new Array<number>(32).fill(0);
  head[0] = kind;
  head[1] = typeCode;
  head[2] = decimals;
  head.splice(3, 4, ...u32be(rowLength));
  head.splice(7, 4, ...u32be(size));
  head[11] = [...name].length;
  return [...head, ...utf16le(name)];
}

/** V5 legacy 对象头（15 字节 + 单字节名）。 */
function v5ObjectHeader(kind: number, typeCode: number, rowLength: number, size: number, name: string): number[] {
  const head = new Array<number>(15).fill(0);
  head[0] = kind;
  head[1] = typeCode;
  head.splice(2, 2, ...u16be(rowLength));
  head.splice(4, 2, ...u16be(size));
  head[6] = name.length;
  return [...head, ...asciiBytes(name)];
}

/** V6 描述符 7 字节项。 */
function desc6(marker: number, code: number, decimals: number, length: number): number[] {
  return [marker, code, decimals, ...u32be(length)];
}

/** V5 描述符 4 字节项。 */
function desc5(marker: number, code: number, length: number): number[] {
  return [marker, code, ...u16be(length)];
}

/** 一段定长行数据（BC n bytes BD）。 */
function rowRun(bytes: number[]): number[] {
  return [0xbc, ...u32be(bytes.length), ...bytes, 0xbd];
}

/** SAP LZH 包装：明文 → raw DEFLATE → 整体位串左移 2 位（垫 0 前缀，声明
 *  0 位额外噪声；算法 1 版本 0）。 */
function sapLzh(plain: Uint8Array): Uint8Array {
  const deflated = deflateRawSync(plain, { level: 6 });
  // DEFLATE 位流 LSB-first——SAP 在其前垫 2 位前缀，等价于整体左移 2 位
  const shifted = new Uint8Array(deflated.byteLength + 1);
  let carry = 0;
  for (let i = 0; i < deflated.byteLength; i += 1) {
    shifted[i] = (((deflated[i]! << 2) | carry) & 0xff);
    carry = deflated[i]! >> 6;
  }
  shifted[deflated.byteLength] = carry;
  const stream = new Uint8Array(8 + deflated.byteLength + 1);
  const view = new DataView(stream.buffer);
  view.setUint32(0, plain.byteLength, true);
  stream[4] = 0x02; // 低 nibble 算法 2（LZH）
  stream[5] = 0x1f;
  stream[6] = 0x9d;
  stream[7] = 0;
  stream.set(shifted, 8);
  return stream.subarray(0, 8 + shifted.byteLength);
}

/* ---- LZC 最小生成器：按 compress(1) "每 chunk 恰 8 码"怪癖打包 ---- */

/** 把码的 chunk 分组按 LSB-first、width 位宽打包：每组一个 chunk（width 字节
 *  容 8 码），组内不足 8 码的尾部按 0 填充——模拟 compress(1) 的块式打包。 */
function packLzcChunks(chunks: number[][], width: number): Uint8Array {
  const bits: number[] = [];
  for (const codes of chunks) {
    for (let k = 0; k < 8; k += 1) {
      const code = codes[k] ?? 0; // chunk 尾填充（解码端在 clear/扩宽处丢弃之）
      for (let i = 0; i < width; i += 1) bits.push((code >>> i) & 1);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b |= bits[i + j]! << j;
    out.push(b);
  }
  return Uint8Array.from(out);
}

/** SAP LZC 包装（block mode、宽度上限 16，算法 1）。codes 传码数组（自动按
 *  8 码/chunk 分组）或 chunk 分组（number[][]，clear 语义测试用）。 */
function sapLzc(codes: number[] | number[][], plainLength: number, extra = 0x80 | 16): Uint8Array {
  const chunks: number[][] = Array.isArray(codes[0])
    ? codes as number[][]
    : (codes as number[]).reduce<number[][]>((acc, code) => {
        if (acc.length === 0 || acc[acc.length - 1]!.length === 8) acc.push([code]);
        else acc[acc.length - 1]!.push(code);
        return acc;
      }, []);
  const body = packLzcChunks(chunks, 9);
  const stream = new Uint8Array(8 + body.byteLength);
  const view = new DataView(stream.buffer);
  view.setUint32(0, plainLength, true);
  stream[4] = 0x01; // 低 nibble 算法 1（LZC）
  stream[5] = 0x1f;
  stream[6] = 0x9d;
  stream[7] = extra;
  stream.set(body, 8);
  return stream;
}

/* ==========================================================================
 * SAP 压缩层
 * ========================================================================== */

describe('sapcompress（LZH/LZC 解压）', () => {
  it('LZH：raw DEFLATE + SAP 前缀解压，输出与头声明长度精确对账', () => {
    const plain = Uint8Array.from('cluster body to compress, repeated repeated repeated'.split('').map(c => c.charCodeAt(0)));
    const out = sapDecompress(sapLzh(plain));
    expect(Buffer.compare(Buffer.from(out), Buffer.from(plain))).toBe(0);
  });

  it('LZH：输出超出头声明长度（截断声明）必须被拒', () => {
    const plain = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const stream = sapLzh(plain);
    new DataView(stream.buffer).setUint32(0, 4, true); // 谎报长度
    expect(() => sapDecompress(stream)).toThrow(/promised 4|larger than/);
  });

  it('LZC：全字面量码序列解压（block mode，9 位宽内）', () => {
    const plain = 'CLUSTER_LZC_PLAINTEXT_123';
    const codes = [...plain].map(c => c.charCodeAt(0));
    const out = sapDecompress(sapLzc(codes, plain.length));
    expect(Buffer.from(out).toString('latin1')).toBe(plain);
  });

  it('LZC：KwKwK（码指向正在定义的表项）解压为前一串加其首字节', () => {
    // 码序列 97('a') 98('b') 258(=nextFree)：解码为 "a"+"b"+"bb"="abbb"
    const out = sapDecompress(sapLzc([97, 98, 258], 4));
    expect(Buffer.from(out).toString('latin1')).toBe('abbb');
  });

  it('LZC：清除码重置字典与码宽，且当前 chunk 尾作废（compress(1) 怪癖）', () => {
    // 97('a') 256(clear) | chunk 尾丢弃 | 98('b') → "ab"；clear 后必须按
    // chunk 边界重新封包（每 chunk 恰 8 个 9 位码 = 9 字节）
    const out = sapDecompress(sapLzc([[97, 256], [98]], 2));
    expect(Buffer.from(out).toString('latin1')).toBe('ab');
  });

  it('LZC：非法码宽上限被拒（limit 位域全零）', () => {
    const stream = sapLzc([65], 1, 0x80 | 0);
    expect(() => sapDecompress(stream)).toThrow(/code width limit/);
  });

  it('缺 SAP 魔数的体不是压缩流（ParseHeader 拒绝）', () => {
    expect(() => parseSapCompressHeader(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/no SAP compression signature/);
  });

  it('头声明长度超过绝对上限（1MB）直接拒绝——资源主防线', () => {
    const stream = sapLzh(Uint8Array.from([65]));
    new DataView(stream.buffer).setUint32(0, 2 * 1024 * 1024, true);
    expect(() => sapDecompress(stream)).toThrow(/outside supported bounds/);
  });
});

/* ==========================================================================
 * V6 集群（Unicode 内核形态）
 * ========================================================================== */

/** 拼装 V6 集群字节（format 1 明文 / 2 压缩——压缩体由调用方先造好）。 */
function v6Cluster(codepage: string, body: number[]): Uint8Array {
  const bodyBytes = codepage === '4103-plain' || codepage === '1100-plain' ? body : body;
  void bodyBytes;
  return Uint8Array.from([...clusterHeader(6, 1, codepage.replace(/-plain$/, '')), ...body]);
}

describe('parseCluster：V6 路径', () => {
  it('elementary CHAR（UTF-16 码页 4103）解码并去尾随空白', () => {
    const obj = [...v6ObjectHeader(1, 0x00, 0, 8, 0, 'F'), ...rowRun([...utf16le('AB  ')]), 0x04];
    const cl = parseCluster(v6Cluster('4103', obj));
    expect(cl.version).toBe(6);
    expect(cl.codepage).toBe('4103');
    expect(cl.compressed).toBe(false);
    expect(cl.objects).toHaveLength(1);
    expect(cl.objects[0]!.rows).toEqual([['AB']]);
    expect(cl.object('F')?.rows[0]).toEqual(['AB']);
    expect(cl.object('missing')).toBeUndefined();
  });

  it('elementary 全类型谱：INT4/INT2/INT1/INT8/FLTP/DEC(小数位)/RAW/DATS', () => {
    const body = [
      ...v6ObjectHeader(1, 0x08, 0, 4, 0, 'I4'), ...rowRun([0x2a, 0x00, 0x00, 0x00]),
      ...v6ObjectHeader(1, 0x1b, 0, 8, 0, 'I8'), ...rowRun([0xd2, 0x02, 0x96, 0x49, 0x00, 0x00, 0x00, 0x00]),
      ...v6ObjectHeader(1, 0x02, 2, 4, 0, 'PK'), ...rowRun([0x12, 0x34, 0x56, 0x7d]),
      ...v6ObjectHeader(1, 0x04, 0, 2, 0, 'RW'), ...rowRun([0xde, 0xad]),
      0x04
    ];
    const cl = parseCluster(v6Cluster('4103', body));
    const [i4, i8, pk, raw] = cl.objects;
    expect(i4!.rows[0]).toEqual([42]);
    // INT8 以字符串保全精度（JS number >2^53 丢精度；1234567890 恰在安全区）
    expect(i8!.rows[0]).toEqual(['1234567890']);
    expect(pk!.rows[0]).toEqual(['-12345.67'.replace('-12345.67', '-12345.67')]);
    expect(pk!.rows[0][0]).toBe('-12345.67');
    expect(raw!.rows[0]).toEqual(['DEAD']);
  });

  it('平结构含对齐填充（filler 无值）与 include 子结构', () => {
    // 结构 { CHAR(2), filler(2), include { CHAR(2) } } 行长 6
    const body = [
      ...v6ObjectHeader(2, 0x0e, 0, 6, 0, 'S'),
      0xab, 0x0e, 0x00, ...u32be(6),
      ...desc6(0xaa, 0x00, 0, 2),
      ...desc6(0xaf, 0x00, 0, 2),
      ...desc6(0xab, 0x0e, 0, 2), ...desc6(0xaa, 0x00, 0, 2), ...desc6(0xac, 0x0e, 0, 2),
      ...desc6(0xac, 0x0e, 0, 6),
      ...rowRun([...asciiBytes('AB--CD')]),
      0x04
    ];
    const cl = parseCluster(v6Cluster('1100', body));
    const obj = cl.objects[0]!;
    expect(obj.fields.map(f => `${f.path}:${f.type}:${f.length}`)).toEqual(['1:CHAR:2', '2.1:CHAR:2']);
    expect(obj.rows[0]).toEqual(['AB', 'CD']);
  });

  it('deep 结构：离行 STRING 与嵌套表组件（0xAD）', () => {
    // { CHAR(2), STRING, TABLE<CHAR(1)> }——行槽 2+8+8=18；行数据 =
    // BC run(CHAR2) + CA string + BE 嵌套表
    const lineLen = 1;
    const body = [
      ...v6ObjectHeader(5, 0x0f, 0, 18, 0, 'DEEP'),
      0xab, 0x0f, 0x00, ...u32be(18),
      ...desc6(0xaa, 0x00, 0, 2),
      ...desc6(0xaa, 0x13, 0, 0), // STRING 组件（length 0，槽 8 字节）
      ...desc6(0xad, 0x00, 0, lineLen), ...desc6(0xaa, 0x00, 0, 1), ...desc6(0xae, 0x00, 0, lineLen),
      ...desc6(0xac, 0x0f, 0, 18),
      ...rowRun([...asciiBytes('AB')]),
      0xca, ...u32be(7), ...asciiBytes('a value'), 0xcb,
      0xbe, ...u32be(lineLen), ...u32be(2),
      ...rowRun([0x58]), // 'X'
      ...rowRun([0x59]), // 'Y'
      0xbf,
      0x04
    ];
    const cl = parseCluster(v6Cluster('1100', body));
    const obj = cl.objects[0]!;
    expect(obj.typeCode).toBe(0x0f);
    expect(obj.fields.map(f => f.path)).toEqual(['1', '2', '3']);
    expect(obj.fields[2]!.type).toBe('TABLE');
    expect(obj.fields[2]!.fields?.map(f => f.type)).toEqual(['CHAR']);
    expect(obj.rows[0]).toEqual(['AB', 'a value', [['X'], ['Y']]]);
  });

  it('顶层 TABLE 对象（kind 6）多行与空表', () => {
    const mk = (rows: number[][]): number[] => [
      ...v6ObjectHeader(6, 0x0e, 0, 2, 0, 'T'),
      0xad, 0x0e, 0x00, ...u32be(2), ...desc6(0xaa, 0x00, 0, 2), ...desc6(0xae, 0x0e, 0, 2),
      0xbe, ...u32be(2), ...u32be(rows.length),
      ...rows.flatMap(r => rowRun(r)),
      0xbf,
      0x04
    ];
    const two = parseCluster(v6Cluster('1100', mk([[0x61, 0x61], [0x62, 0x62]])));
    expect(two.objects[0]!.kind).toBe('table');
    expect(two.objects[0]!.rows).toEqual([['aa'], ['bb']]);
    const empty = parseCluster(v6Cluster('1100', mk([])));
    expect(empty.objects[0]!.rows).toEqual([]);
  });

  it('LZH 压缩 V6 集群与明文等价', () => {
    const plain = [
      ...v6ObjectHeader(1, 0x00, 0, 8, 0, 'F'), ...rowRun([...utf16le('ABCD')]),
      0x04
    ];
    const plainCluster = Uint8Array.from([...clusterHeader(6, 1, '4103'), ...plain]);
    const bodyCompressed = sapLzh(Uint8Array.from(plain));
    const compressedCluster = Uint8Array.from([...clusterHeader(6, 2, '4103'), ...bodyCompressed]);
    const a = parseCluster(plainCluster);
    const b = parseCluster(compressedCluster);
    expect(b.compressed).toBe(true);
    expect(b.algorithm).toBe('LZH');
    expect(JSON.stringify(b.objects)).toBe(JSON.stringify(a.objects));
  });

  it('DF16/DF34 十进制浮点（密集打包十进制）', () => {
    // decimal64 的 2.5：sign 0、组合域含 msd=2、指数、尾数 declet 5
    // 用 Go oracle 已验证的位型——直接取 DF16(2.5) 的标准编码
    const df16of25 = [0x25, 0x00, 0x00, 0x00, 0x00, 0x00, 0x34, 0x22];
    const body = [
      ...v6ObjectHeader(1, 0x17, 0, 8, 0, 'D16'), ...rowRun(df16of25),
      0x04
    ];
    const cl = parseCluster(v6Cluster('4103', body));
    expect(cl.objects[0]!.rows[0]![0]).toBe('2.5');
  });

  it('fail-closed：未知版本/未知 kind/未知描述符标记/截断/长度对账失败', () => {
    // 未知版本
    const badVersion = Uint8Array.from([...clusterHeader(7, 1, '4103'), 0x04]);
    expect(() => parseCluster(badVersion)).toThrow(/version 7/);
    // 未知对象 kind
    const badKind = Uint8Array.from([...clusterHeader(6, 1, '4103'), ...v6ObjectHeader(9, 0, 0, 1, 0, 'X'), 0x04]);
    expect(() => parseCluster(badKind)).toThrow(/unknown object kind 0x09/);
    // 未知描述符标记（0x99）
    const badMarker = Uint8Array.from([
      ...clusterHeader(6, 1, '1100'),
      ...v6ObjectHeader(2, 0x0e, 0, 2, 0, 'S'),
      0xab, 0x0e, 0x00, ...u32be(2),
      ...desc6(0x99, 0x00, 0, 2),
      0xac,
      0x04
    ]);
    expect(() => parseCluster(badMarker)).toThrow(/unknown descriptor marker 0x99/);
    // 行数据截断
    const truncated = Uint8Array.from([...clusterHeader(6, 1, '4103'), ...v6ObjectHeader(1, 0x00, 0, 8, 0, 'F'), 0xbc, 0x00, 0x00, 0x00]);
    expect(() => parseCluster(truncated)).toThrow(/truncated/);
    // 描述符行长与对象头行长不一致
    const lengthMismatch = Uint8Array.from([
      ...clusterHeader(6, 1, '1100'),
      ...v6ObjectHeader(2, 0x0e, 0, 5, 0, 'S'),
      0xab, 0x0e, 0x00, ...u32be(4), ...desc6(0xaa, 0x00, 0, 4), ...desc6(0xac, 0x0e, 0, 4),
      0x04
    ]);
    expect(() => parseCluster(lengthMismatch)).toThrow(/does not match row length/);
    // 缺结束标记
    const noEnd = Uint8Array.from([...clusterHeader(6, 1, '4103'), ...v6ObjectHeader(1, 0x00, 0, 4, 0, 'F'), ...rowRun([...utf16le('AB')])]);
    expect(() => parseCluster(noEnd)).toThrow(/end marker/);
  });

  it('fail-closed：描述符节点/深度超限（DoS 防线）', () => {
    // 深度超限：9 层嵌套子结构（close 同为 7 字节项且长度逐层一致）
    let deep: number[] = [...desc6(0xaa, 0x00, 0, 1)];
    for (let d = 9; d >= 1; d -= 1) deep = [...desc6(0xa0, 0x0e, 0, d), ...deep, ...desc6(0xa1, 0x0e, 0, d)];
    const deepCluster = Uint8Array.from([
      ...clusterHeader(6, 1, '1100'),
      ...v6ObjectHeader(2, 0x0f, 0, 1, 0, 'D'),
      0xab, 0x0f, 0x00, ...u32be(1), ...deep, 0xac,
      ...rowRun([0x41]),
      0x04
    ]);
    expect(() => parseCluster(deepCluster)).toThrow(/nesting limit|node limit/);
  });
});

/* ==========================================================================
 * V5 legacy 集群（老内核形态）
 * ========================================================================== */

describe('parseCluster：V5 legacy 路径', () => {
  it('elementary 与平结构（4 字节描述符项、BB 行、单字节码页）', () => {
    const body = [
      ...v5ObjectHeader(1, 0x00, 3, 0, 'C3'),
      0xbb, 0x41, 0x42, 0x20, // 'AB '
      ...v5ObjectHeader(2, 0x0e, 4, 0, 'S'),
      0xab, 0x0e, ...u16be(4),
      ...desc5(0xaa, 0x00, 2),
      ...desc5(0xaa, 0x02, 2), // DEC(2) = 3 位数字
      ...desc5(0xac, 0x0e, 4),
      0xbb, 0x58, 0x59, 0x12, 0x3c, // 'XY' + packed 123 符号 C
      0x04
    ];
    const cl = parseCluster(Uint8Array.from([...clusterHeader(5, 1, '1100'), ...body]));
    expect(cl.version).toBe(5);
    expect(cl.objects[0]!.rows[0]).toEqual(['AB']);
    expect(cl.objects[1]!.rows[0]).toEqual(['XY', '123']);
  });

  it('V5 拒绝 0xAD 嵌套表组件（deep 边界与上游 legacy 一致；V6 才支持）', () => {
    const body = [
      ...v5ObjectHeader(2, 0x0f, 8, 0, 'D'),
      0xab, 0x0f, ...u16be(8),
      ...desc5(0xad, 0x00, 1), // V5 无此形态
      0xac,
      0x04
    ];
    expect(() => parseCluster(Uint8Array.from([...clusterHeader(5, 1, '1100'), ...body]))).toThrow(/unknown descriptor marker 0xad/i);
  });
});

/* ==========================================================================
 * 片段组装与 hex 解码
 * ========================================================================== */

describe('joinFragments / decodeClusterHex', () => {
  it('按 SRTF2 排序、按 CLUSTR 裁剪补零、拼回完整流', () => {
    const joined = joinFragments([
      { seq: 1, length: 2, data: Uint8Array.from([0x03, 0x04, 0x00, 0x00]) },
      { seq: 0, length: 2, data: Uint8Array.from([0x01, 0x02, 0xff]) }
    ]);
    expect([...joined]).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('缺片/重复 fail-closed，绝不静默拼接', () => {
    expect(() => joinFragments([
      { seq: 0, length: 1, data: Uint8Array.from([1]) },
      { seq: 2, length: 1, data: Uint8Array.from([2]) }
    ])).toThrow(/fragment 1 is missing/);
    expect(() => joinFragments([
      { seq: 0, length: 1, data: Uint8Array.from([1]) },
      { seq: 0, length: 1, data: Uint8Array.from([1]) }
    ])).toThrow(/appears twice/);
    expect(() => joinFragments([])).toThrow(/no fragments/);
  });

  it('decodeClusterHex：大小写混合与空白容忍、非法 hex 拒绝', () => {
    expect([...decodeClusterHex('De Ad\n 01')]).toEqual([0xde, 0xad, 0x01]);
    expect(() => decodeClusterHex('zz')).toThrow(/not hex/);
    expect(() => decodeClusterHex('abc')).toThrow(/not hex/); // 奇数长度
  });
});

/* ==========================================================================
 * 对象级容错（tolerant）
 * ========================================================================== */

describe('parseCluster：tolerant 对象级容错', () => {
  it('collects objects before the failure point and surfaces the exact diagnostic', () => {
    // 好对象（CHAR）+ 坏对象（描述符含未知标记 0x99）+ 尾随好对象不可达
    const body = [
      ...v6ObjectHeader(1, 0x00, 0, 8, 0, 'GOOD'), ...rowRun([...utf16le('ABCD')]),
      ...v6ObjectHeader(2, 0x0e, 0, 2, 0, 'BAD'),
      0xab, 0x0e, 0x00, ...u32be(2), ...desc6(0x99, 0x00, 0, 2), ...desc6(0xac, 0x0e, 0, 2),
      0x04
    ];
    const cl = parseCluster(v6Cluster('4103', body), { tolerant: true });
    expect(cl.objects.map(o => o.name)).toEqual(['GOOD']);
    expect(cl.objects[0]!.rows[0]).toEqual(['ABCD']);
    expect(cl.partialErrors).toHaveLength(1);
    expect(cl.partialErrors[0]).toContain('object 2');
    expect(cl.partialErrors[0]).toContain('0x99');
    // 非 tolerant 默认整流失败（行为不变）
    expect(() => parseCluster(v6Cluster('4103', body))).toThrow(/0x99/);
  });

  it('tolerant cluster with zero objects still fails (nothing was decoded)', () => {
    const body = [0x04]; // 无对象无诊断——空集群仍是错误
    expect(() => parseCluster(v6Cluster('4103', body), { tolerant: true })).toThrow(/no objects/);
  });
});
