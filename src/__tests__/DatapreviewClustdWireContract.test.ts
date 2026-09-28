/**
 * datapreview XML wire 契约测试（EUFUNC CLUSTD 读取前置，阶段 A 离线项）。
 *
 * 目的：在接入任何 CLUSTD 解码器之前，用 mock XML 锁定主项目 datapreview
 * 解析链（parseQueryResponse + decodeQueryResult）对 RAW/hex 二进制列的
 * 行为契约，并显式记录三类已知风险，供真机探针（阶段 B）逐项证实或证伪：
 *
 *   A. RAW/XSTRING 列在 decode=true/false 下均原样返回文本（parseValue 的
 *      default 分支）——hex 是否被数值化/转码/裁剪由此处契约兜底；
 *   B. NULL 列不输出 <data> 元素（2026-09-28 真机已证形态，见 95d4bf2）会
 *      造成该列整体错位且无告警——若 CLUSTD 自身出现 NULL 行，片段拼接将
 *      静默错乱，接入前必须先给 parser 加安全机制；
 *   C. <data> 元素若带属性，fullParse 默认 parseAttributeValue:true 会把
 *      单元格解析成对象（属性值还会被数值化成 boolean/number），parseValue
 *      default 分支原样返回该对象——下游当字符串消费时才损坏；真实 wire
 *      是否存在此形态须由阶段 B 确认。
 *
 * 本文件全部离线（零网络、零 SAP），合成 XML 形态对齐 ApplicationLogApi
 * 测试的 tableData 结构与真机取证记录。不在此处引入 decoder——hex → bytes
 * 的还原规则仅以 Buffer.from(hex,'hex') 做可重组性证明，不是集成承诺。
 */
import { parseQueryResponse, decodeQueryResult, TypeKinds } from '../adt/api/tablecontents';

/**
 * 构造一列（一个 <columns> 元素：metadata + dataSet>data）。
 * type 对应 ADT TypeKinds（X=RAW, y=XSTRING, I=INT4, C=CHAR, D=DATS…）。
 * values 中的 undefined 表示该行不输出 <data> 元素（真机 NULL 列形态）。
 */
function column(name: string, type: string, values: Array<string | undefined>, length = 0): string {
  const metaLen = length || Math.max(...values.map(v => (v ?? '').length), 1);
  const dataTags = values
    .map(v => (v === undefined ? null : `      <data>${v}</data>`))
    .filter((t): t is string => t !== null)
    .join('\n');
  return `  <columns>
    <metadata name="${name}" type="${type}" keyAttribute="false" length="${metaLen}"/>
    <dataSet>
${dataTags}
    </dataSet>
  </columns>`;
}

/** 包装成带默认命名空间的 tableData 响应（removeNSPrefix 兼容真机形态）。 */
function tableDataXml(columns: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tableData xmlns="http://www.sap.com/adt/datapreview/tabledata">
${columns.join('\n')}
</tableData>`;
}

/** 合成一段确定性 hex（可逆：Buffer 往返一致），避免随机数据带来的偶发。 */
function syntheticHex(byteLength: number, seed = 0x5a): string {
  const bytes = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i++) bytes[i] = (seed + i * 31) % 256;
  return bytes.toString('hex');
}

describe('datapreview XML wire 契约：RAW/hex 列基线（CLUSTD 读取前置）', () => {
  it('CLUSTD 列 type=X 在 decode=false 下原样返回 hex 文本，长度逐字符保持', () => {
    const hex = syntheticHex(32); // 64 个 hex 字符
    const xml = tableDataXml([
      column('NAME', 'C', ['Z_FM']),
      column('CLUSTD', 'X', [hex], 2000)
    ]);
    const { columns, values } = parseQueryResponse(xml);

    expect(columns).toMatchObject([{ name: 'NAME' }, { name: 'CLUSTD' }]);
    expect(values[0].CLUSTD).toBe(hex);
    expect((values[0].CLUSTD as string).length).toBe(64);
  });

  it('CLUSTD 列 type=X 在 decode=true 下同样原样返回（parseValue default 分支不转码 RAW）', () => {
    // 契约：TypeKinds.HEX('X') 不在 parseValue 的 switch 内，decode 不改变文本。
    // 若未来 parser 改动导致 RAW 被隐式转换，此用例立即失败以保护 wire 假设。
    const hex = '00ABcdEF0123456789abcdefFEDCBA98'; // 大小写混合 + 前导零
    const xml = tableDataXml([column('CLUSTD', 'X', [hex], 16)]);
    const decoded = decodeQueryResult(parseQueryResponse(xml));

    expect(decoded.values[0].CLUSTD).toBe(hex); // 前导零、大小写、连续性均不被裁剪/转换
  });

  it('XSTRING 列 type=y 同样原样返回（RAWVARC/STRING 二进制同口径）', () => {
    const hex = syntheticHex(8);
    const decoded = decodeQueryResult(parseQueryResponse(tableDataXml([
      column('CLUSTR', 'y', [hex], 22)
    ])));
    expect(decoded.values[0].CLUSTR).toBe(hex);
  });

  it('decode=false 时全列保持字符串；decode=true 时 SRTF2(INT) 被数值化而 CLUSTD 不变', () => {
    const hex = '48656C6C6F';
    const cols = [
      column('SRTF2', 'I', ['0', '1', '2'], 4),
      column('CLUSTD', 'X', [hex, hex, hex], 2000)
    ];
    const raw = parseQueryResponse(tableDataXml(cols));
    expect(raw.values.map(r => r.SRTF2)).toEqual(['0', '1', '2']); // 未解码：字符串
    expect(raw.values.map(r => r.CLUSTD)).toEqual([hex, hex, hex]);

    const decoded = decodeQueryResult(raw);
    expect(decoded.values.map(r => r.SRTF2)).toEqual([0, 1, 2]); // INT4 → number（无损）
    expect(decoded.values.map(r => r.CLUSTD)).toEqual([hex, hex, hex]); // RAW 不动
  });

  it('多 SRTF2 续块：按行原样返回且可逐行 hex 还原后无损重组（decoder 拼接前提证明）', () => {
    // 模拟一个 3 片段集群：片段边界处字节被切分。若 wire 是连续 hex 且无错位，
    // 逐行 Buffer.from → concat 必须精确还原源字节。此规则是未来 decoder
    // 集成的硬前提；真机探针须证实 wire 确为 hex 后此证明才生效。
    const whole = Buffer.from('CLUSTD-WIRE-CONTRACT-PROOF-'.repeat(4), 'utf8');
    const chunk = 10;
    const fragments: string[] = [];
    for (let i = 0; i < whole.length; i += chunk) {
      fragments.push(whole.subarray(i, i + chunk).toString('hex'));
    }
    const rows = fragments.map((hex, srtf2) => ({ hex, srtf2: String(srtf2) }));
    const xml = tableDataXml([
      column('SRTF2', 'I', rows.map(r => r.srtf2), 4),
      column('CLUSTD', 'X', rows.map(r => r.hex), 2000)
    ]);

    const { values } = decodeQueryResult(parseQueryResponse(xml));
    const sorted = [...values].sort((a, b) => (a.SRTF2 as number) - (b.SRTF2 as number));
    const joined = Buffer.concat(sorted.map(r => Buffer.from(r.CLUSTD as string, 'hex')));
    expect(joined.equals(whole)).toBe(true);
  });

  it('超长 CLUSTD（256KB 字节 = 512K hex 字符）解析不截断', () => {
    // 契约：parse 层没有单值长度上限，大集群片段不会被静默裁剪。
    // 资源预算（总字节/行数/膨胀率）属未来接入层的责任，parse 层现状如实记录。
    const hex = syntheticHex(256 * 1024);
    const { values } = parseQueryResponse(tableDataXml([column('CLUSTD', 'X', [hex], 32000)]));
    expect(values[0].CLUSTD).toBe(hex);
  });

  it('非法 hex 字符在 parse/decode 层原样通过（格式校验是 decoder 的责任，parser 不代劳）', () => {
    // 现状锁定：非 hex 文本走到 decoder 前不会被拦截，decoder 必须 fail-closed。
    const bad = 'NOT-HEX!@#$';
    const { values } = decodeQueryResult(parseQueryResponse(tableDataXml([
      column('CLUSTD', 'X', [bad], 2000)
    ])));
    expect(values[0].CLUSTD).toBe(bad);
  });
});

describe('datapreview XML wire 契约：NULL 省略与行对齐风险（真机已证形态）', () => {
  it('非 CLUSTD 列出现 NULL（省略 <data>）时：该列整体上移错位，CLUSTD 列不受影响', () => {
    // 真机证据（2026-09-28，95d4bf2）：NULL 列在 datapreview XML 中完全不输出
    // <data> 元素。parseQueryResponse 逐列独立按索引取值，短列从错位处开始
    // 与其他列错行、末行为 undefined——当前行为如实锁定：
    // LANGU 列 3 行只有 2 个 data → values 变 ['1','3'] + 末行 undefined。
    const xml = tableDataXml([
      column('SRTF2', 'I', ['0', '1', '2'], 4),
      column('LANGU', 'C', ['1', undefined, '3'], 1), // 第 2 行 NULL → 省略 data
      column('CLUSTD', 'X', ['AA', 'BB', 'CC'], 2000)
    ]);
    const { values } = parseQueryResponse(xml);

    expect(values).toHaveLength(3);
    expect(values.map(r => r.CLUSTD)).toEqual(['AA', 'BB', 'CC']); // CLUSTD 列自身完整 → 对齐
    expect(values.map(r => r.LANGU)).toEqual(['1', '3', undefined]); // 已知错位：第 2 行取到第 3 行值
  });

  it('危险现状：CLUSTD 列自身出现 NULL（省略 <data>）时片段整体错位且无任何告警', () => {
    // 这是接入 CLUSTD 前必须先修复的 parser 安全缺陷：若某集群片段为 NULL，
    // 该列所有后续值上移一行，拼接出的 payload 静默错乱。此用例刻意断言
    // 「错位发生且无异常抛出」，作为回归警示——未来给 parser 加 NULL/缺格
    // 检测后，本用例必须随新契约同步改写为「报告不完整/失败」。
    const xml = tableDataXml([
      column('SRTF2', 'I', ['0', '1', '2'], 4),
      column('CLUSTD', 'X', ['AA', undefined, 'CC'], 2000) // 片段 1 为 NULL
    ]);
    const { values } = parseQueryResponse(xml);

    expect(values.map(r => r.CLUSTD)).toEqual(['AA', 'CC', undefined]); // 错位上移
    // 现状下没有任何截断/缺格标记可供调用方检测——无告警是缺陷本身的一部分
    expect(values[1].CLUSTD).not.toBeUndefined();
  });

  it('多行时空字符串单元格保留在行内；单行且唯一单元格为空串时整行静默消失（xmlArray falsy 缺陷）', () => {
    // 实测锁定（fast-xml-parser + xmlArray 链）：
    // - 多行：<dataSet> 是 3 元素数组，空串原位保留，无错位；
    // - 单行：xmlNode 返回 "" → xmlArray 的 if(node) 视为 falsy → 该列 values=[]
    //   → longest 为空 → values 为空数组，整行消失且无告警。若未来接入层用
    //   "空 payload 探针行"验证通道，此缺陷会伪装成"无数据"。
    const multi = parseQueryResponse(tableDataXml([
      column('SRTF2', 'I', ['0', '1', '2'], 4),
      column('CLUSTD', 'X', ['AA', '', 'CC'], 2000)
    ]));
    expect(multi.values.map(r => r.CLUSTD)).toEqual(['AA', '', 'CC']);

    const single = parseQueryResponse(tableDataXml([column('CLUSTD', 'X', [''], 2000)]));
    expect(single.values).toEqual([]); // 危险现状：单行空值 → 零行返回
  });
});

describe('datapreview XML wire 契约：带属性单元格与 DATS 转换风险', () => {
  it('风险锁定：<data> 带属性时单元格被解析成对象，decode 后退化为 "[object Object]"', () => {
    // fullParse 默认 parseAttributeValue:true，parseQueryResponse 未覆盖该选项。
    // 若真实 wire 的 <data> 元素带任何属性（如 null 标记、长度标注），单元格
    // 值将不是字符串，parseValue 返回 "[object Object]" —— 静默损坏。
    // 真机探针（阶段 B）必须确认 EUFUNC 查询响应的 <data> 是否带属性；
    // 若带，接入前 parser 需显式处理（提取 #text 或拒绝并报告）。
    // column() 不支持属性形态，此处手工拼带 null 属性的 data 元素
    const manualXml = `<?xml version="1.0" encoding="UTF-8"?>
<tableData xmlns="http://www.sap.com/adt/datapreview/tabledata">
  <columns>
    <metadata name="CLUSTD" type="X" keyAttribute="false" length="2000"/>
    <dataSet>
      <data null="true"/>
    </dataSet>
  </columns>
</tableData>`;

    const { values } = parseQueryResponse(manualXml);
    const cell = values[0].CLUSTD;
    // 实测锁定：单元格退化为对象 { "@_null": true }（parseAttributeValue:true
    // 还把属性值数值化成 boolean）；parseValue default 分支原样返回该对象，
    // 不会字符串化——下游一旦当 hex 字符串消费才损坏。锁定此风险路径。
    expect(cell).toEqual({ '@_null': true });
    const decoded = decodeQueryResult({ columns: [{ name: 'CLUSTD', type: TypeKinds.HEX, description: '', keyAttribute: false, colType: '', isKeyFigure: false, length: 2000 }], values: [{ CLUSTD: cell }] });
    expect(decoded.values[0].CLUSTD).toEqual({ '@_null': true });
  });

  it('风险锁定：DATS 列 decode=true 被转成 Date 对象（EUFUNC.DATUM 目录日期的既有隐患）', () => {
    // EUFUNC 的 DATUM 列是 DATS（TypeKinds.DATE='D'）。getFmTestDataSets 走
    // decode=true 通道；若真机对该列回报 type='D'，日期将变成 JS Date，再经
    // cellText 的 String() 变成 "Wed Sep 01 2026 ..." 而非 'YYYYMMDD'。
    // 真机目录层 smoke 未断言 date 格式，故此风险未被真机证据排除。
    // decode=false 原样字符串是未来接入的规避口径之一；现状如实锁定。
    const cols = [
      column('DATUM', 'D', ['20260901'], 8),
      column('ZEIT', 'T', ['090000'], 6)
    ];
    const decoded = decodeQueryResult(parseQueryResponse(tableDataXml(cols)));
    expect(decoded.values[0].DATUM).toBeInstanceOf(Date); // 现状：有损转换
    expect(decoded.values[0].ZEIT).toBe('090000'); // TIMS 走 default，原样
  });
});

describe('datapreview XML wire 契约：EUFUNC 完整行形态对照', () => {
  it('EUFUNC 全列形态（含 CLUSTR/CLUSTD）decode=false 逐列原样，作为阶段 B 探针的对照基线', () => {
    // 列形态对齐真机取证（2026-09-25，sap-demo EUFUNC 实查，real-dev-verified.md）
    const clustd = syntheticHex(64);
    const clustr = '0123456789ABCDEF0123456789ABCDEF01234567'; // RAW22 → 22 字节 hex
    const xml = tableDataXml([
      column('RELID', 'C', ['FL'], 2),
      column('GRUPPE', 'C', ['EHSSUB04'], 40),
      column('NAME', 'C', ['C162_SPEC_GET_BY_ID'], 30),
      column('NUMMER', 'C', ['999'], 3),
      column('SEQID', 'C', [''], 4),
      column('SRTF2', 'I', ['0'], 4),
      column('LANGU', 'C', ['1'], 1),
      column('AUTOR', 'C', ['SAP'], 12),
      column('DATUM', 'D', ['20260901'], 8),
      column('ZEIT', 'T', ['090000'], 6),
      column('VERSION', 'I', ['1'], 4),
      column('CLUSTR', 'X', [clustr], 22),
      column('CLUSTD', 'X', [clustd], 2000)
    ]);

    const { columns, values } = parseQueryResponse(xml);
    expect(columns).toHaveLength(13);
    expect(values[0].RELID).toBe('FL');
    expect(values[0].CLUSTR).toBe(clustr);
    expect(values[0].CLUSTD).toBe(clustd);
    // 字节还原规则证明（非集成承诺）：hex 长度为字节数两倍且可逆
    expect(Buffer.from(clustd, 'hex')).toHaveLength(64);
  });
});

describe('datapreview XML wire 契约：真机证实形态（2026-09-28 sap-demo，fm-test-data-clustd-real-dev-verified）', () => {
  it('真机实证：CLUSTD 报 type=X、<data> 无属性、连续 mixed-case hex（3800 字节固定 LRAW 宽度）', () => {
    // 真机 Q2/Q4：CLUSTD 列 metadata type='X'，dataWithAttributes=0，
    // 单元格为 7600 hex 字符（=3800 字节固定宽度，含 padding）。
    const hex = syntheticHex(3800);
    const xml = tableDataXml([column('SRTF2', 'I', ['0 '], 4), column('CLUSTR', 's', ['422 '], 4), column('CLUSTD', 'X', [hex], 3800)]);
    const raw = parseQueryResponse(xml);
    expect(raw.columns.find(c => c.name === 'CLUSTD')?.type).toBe('X');
    expect(raw.values[0].CLUSTD).toBe(hex); // decode=false 原样，长度不被裁剪
  });

  it('真机实证：CLUSTR 是 INT2（type=s）承载片段有效字节数；INT 列呈现带尾随空格', () => {
    // 真机推翻合成假设「CLUSTR=RAW22」：实为 INT2（片段字节数），值形如 '422 '。
    // 无损重组规则（padding 模型，真机 Q5 实证 paddingAllZeros=true）：
    // 每片段取 CLUSTD 前 CLUSTR×2 个 hex 字符 → hex decode → 按 SRTF2 拼接。
    const effective = 'CAFEBABE'; // 有效 4 字节的示意 hex（真机 422 字节，此处缩样）
    const padding = '0'.repeat(64);   // 真机：剩余 6756 字符全 '0'
    const xml = tableDataXml([
      column('SRTF2', 'I', ['0 '], 4),
      column('CLUSTR', 's', ['4 '], 4),
      column('CLUSTD', 'X', [effective + padding], 36)
    ]);
    const raw = parseQueryResponse(xml);
    const row = raw.values[0];
    const clustrBytes = parseInt(String(row.CLUSTR).trim(), 10); // 尾随空格由 trim 吸收
    const effectiveHex = String(row.CLUSTD).slice(0, clustrBytes * 2);
    const paddingHex = String(row.CLUSTD).slice(clustrBytes * 2);
    expect(clustrBytes).toBe(4);
    expect(effectiveHex).toBe(effective);
    expect(paddingHex).toMatch(/^0*$/); // padding 全 '0'——真机同规则
    expect(Buffer.from(effectiveHex, 'hex')).toEqual(Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
  });

  it('真机实证：NUMMER 可为 NULL（省略 <data>），nummer<>999 过滤后单元格 undefined（缺格形态再现）', () => {
    // 真机 Q3/Q4：C162 的非 999 测试集行 NUMMER 为 NULL——列无任何 <data> 时
    // （真机服务端生成紧凑 XML，无空白文本），该列单元格 undefined，与阶段 A
    // 锁定的缺格契约一致；拼接/分组逻辑不得假设 NUMMER 恒有值。
    // 手工拼紧凑 XML：column() 对全 undefined 列会生成带缩进空白的 <dataSet>，
    // 在 trimValues:false 下空白文本会被 xmlArray 当作单元格值，非真机形态。
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tableData xmlns="http://www.sap.com/adt/datapreview/tabledata">
  <columns>
    <metadata name="NUMMER" type="C" keyAttribute="false" length="3"/>
    <dataSet></dataSet>
  </columns>
  <columns>
    <metadata name="SRTF2" type="I" keyAttribute="false" length="4"/>
    <dataSet>
      <data>0 </data>
    </dataSet>
  </columns>
</tableData>`;
    const raw = parseQueryResponse(xml);
    expect(raw.values).toHaveLength(1);
    expect(raw.values[0].NUMMER).toBeUndefined();
    expect(raw.values[0].SRTF2).toBe('0 ');
  });
});
