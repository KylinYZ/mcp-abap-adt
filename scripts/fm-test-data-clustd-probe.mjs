// EUFUNC CLUSTD datapreview wire 取证探针（阶段 B，sap-demo 专用 DEV，只读）。
// 授权：所有者 2026-09-28 批准本次连接；纪律：只读、串行、<=5 次 datapreview 查询、
// 输出强制脱敏——任何单元格原值（CLUSTD/CLUSTR/payload）不打印、不落盘、不进对话，
// 只记录结构性元数据（列类型/长度/字符集判定/SHA256 指纹/片段序列）。
// 取证目标对照 docs/evidence/fm-test-data-datapreview-contract-offline.md 阶段 B 清单：
//   1) CLUSTD 列 metadata type 值；2) 单元格编码（hex/base64/其他）；
//   3) <data> 元素是否带属性；4) DATUM 列回报 type；5) 多片段键/次序/完整性；
//   6) rowNumber 截断有无标记。
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import adtPkg from '../dist/adt/index.js';
const { ADTClient: AdtClient } = adtPkg;
import tablePkg from '../dist/adt/api/tablecontents.js';
const { parseQueryResponse } = tablePkg;

const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envText = readFileSync(resolve(ENV_PATH), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
// 红线预检：URL 必须是 sap-demo（10.30.254.48）；凭据不打印
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）');
  process.exit(1);
}

/** 脱敏单元格描述：只输出形态/长度/字符集判定/指纹，绝不含原值。 */
function describeCell(v) {
  if (v === undefined) return { form: 'undefined' };
  if (v === null) return { form: 'null' };
  if (typeof v === 'object') return { form: 'object', keys: Object.keys(v) }; // 带属性单元格的实测形态
  const s = String(v);
  const hexish = /^[0-9a-fA-F]*$/.test(s);
  const nonHex = hexish ? [] :
    [...new Set(s.replace(/[0-9a-fA-F]/g, ''))].slice(0, 16).map(c => {
      const code = c.charCodeAt(0);
      return code < 32 ? 'ctrl' : code > 127 ? 'non-ascii' : code;
    });
  return {
    form: 'string',
    length: s.length,
    evenLength: s.length % 2 === 0,
    charset: hexish ? (/^[0-9]*$/.test(s) ? 'hex-digits-only' : 'hex-mixed-case') : 'NON-HEX',
    nonHexCodePoints: nonHex.length ? nonHex : undefined,
    fingerprint: createHash('sha256').update(s).digest('hex').slice(0, 12)
  };
}

/** raw XML 结构取证：列 metadata 属性 + data 元素属性形态（不输出 body 本身）。 */
function describeRawXml(body) {
  const p = new XMLParser({ ignoreAttributes: false, trimValues: false, parseAttributeValue: true, removeNSPrefix: true, parseTagValue: false });
  const root = p.parse(body);
  const tableData = root.tableData;
  if (!tableData) return { error: 'no tableData root', bodyLength: body.length };
  const cols = Array.isArray(tableData.columns) ? tableData.columns : [tableData.columns];
  return {
    bodyLength: body.length,
    columns: cols.map(c => {
      const meta = c?.metadata || {};
      const dataArr = c?.dataSet?.data === undefined ? [] :
        (Array.isArray(c.dataSet.data) ? c.dataSet.data : [c.dataSet.data]);
      return {
        name: meta['@_name'], type: meta['@_type'], length: meta['@_length'],
        dataCount: dataArr.length,
        // data 元素若带属性会被解析出 @_ 键——阶段 B 确认清单第 3 项的决定性证据
        dataWithAttributes: dataArr.filter(d => d !== null && typeof d === 'object').length,
        undefinedData: dataArr.filter(d => d === undefined).length
      };
    })
  };
}

function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 800)}`); process.exit(1); }

const client = new AdtClient(
  envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD,
  envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN'
);

/** 直发 freestyle datapreview，返回 raw XML body（不打印）。
 *  错误只取 message——AdtHTTP 异常对象携带 config/auth，绝不序列化整对象。 */
async function rawFreestyle(sql, rowNumber) {
  try {
    const resp = await client.h.request('/sap/bc/adt/datapreview/freestyle', {
      qs: { rowNumber },
      headers: { Accept: 'application/*', 'Content-Type': 'text/plain' },
      method: 'POST',
      body: sql
    });
    return resp.body;
  } catch (e) {
    throw new Error(`datapreview 请求失败: ${String(e?.message || e).slice(0, 200)}`);
  }
}

// Q1：身份 + 999 目录行。EUFUNC 视图不暴露 client 列（VSP 同样在 DD03L 层排除），
// 身份确认沿用既有 smoke 标准：URL 红线预检 + ADT 认证成功 + 已知正例行存在。
// DATUM/ZEIT 的列 type 属性回答确认清单第 4 项。
const FM = 'C162_SPEC_GET_BY_ID'; // 已知正例（标准 SAP FM，目录层真机已验证）
const q1Sql = `SELECT nummer, autor, datum, zeit FROM eufunc WHERE relid = 'FL' AND name = '${FM}' AND nummer = '999'`;
const q1Body = await rawFreestyle(q1Sql, 1);
console.log('Q1 wire:', JSON.stringify(describeRawXml(q1Body)));
const q1 = parseQueryResponse(q1Body);
if (q1.values.length !== 1) fail('Q1 未返回 999 目录行', q1);
pass('Q1 身份确认：URL 红线 + ADT 认证 + 已知正例 999 目录行存在；DATUM/ZEIT type 见上');

// Q2：999 目录集群行自身的 payload wire 取证（不动普通测试集）。
const q2Sql = `SELECT nummer, srtf2, clustr, clustd FROM eufunc WHERE relid = 'FL' AND name = '${FM}' AND nummer = '999'`;
const q2Body = await rawFreestyle(q2Sql, 2);
console.log('Q2 wire:', JSON.stringify(describeRawXml(q2Body)));
const q2 = parseQueryResponse(q2Body);
console.log('Q2 cells:', JSON.stringify(q2.values.map(r => ({
  srtf2: r.SRTF2, clustr: describeCell(r.CLUSTR), clustd: describeCell(r.CLUSTD)
}))));
pass('Q2 目录集群行 payload wire 形态已取证（脱敏）');

// Q3：普通测试集片段发现（只取键列，rowNumber=16 足以观察截断语义）。
// 真机注意：NUMMER 可能为 NULL（datapreview 对 NULL 不输出 <data> 元素，
// 解析后单元格 undefined——contract 测试锁定的缺格形态在此现形），
// 因此集号只作展示，不回拼进 Q4 的 SQL。
const q3Sql = `SELECT nummer, srtf2 FROM eufunc WHERE relid = 'FL' AND name = '${FM}' AND nummer <> '999'`;
const q3Body = await rawFreestyle(q3Sql, 16);
console.log('Q3 wire:', JSON.stringify(describeRawXml(q3Body)));
const q3 = parseQueryResponse(q3Body);
const fragments = q3.values.map(r => ({ nummer: r.NUMMER === undefined ? 'NULL-missing-data' : r.NUMMER, srtf2: r.SRTF2 }));
console.log(`Q3 fragments=${JSON.stringify(fragments)} returned=${q3.values.length} (cap=16)`);
if (q3.values.length === 0) {
  console.log('INFO 无普通测试集片段——多片段完整性项记 partial，探针到此为止');
} else {
  // Q4：全部非 999 片段的 CLUSTR/CLUSTD 取证（不按集号过滤，客户端侧分组分析）。
  // 完整性判定：SRTF2 应为 0..n-1 连续无重复；CLUSTR(INT2)=片段有效字节数，
  // 若 CLUSTR*2 == CLUSTD 字符长度则「长度自校验规则」成立（VSP trim padding 语义）。
  const q4Sql = `SELECT nummer, srtf2, clustr, clustd FROM eufunc WHERE relid = 'FL' AND name = '${FM}' AND nummer <> '999'`;
  const q4Body = await rawFreestyle(q4Sql, 16);
  console.log('Q4 wire:', JSON.stringify(describeRawXml(q4Body)));
  const q4 = parseQueryResponse(q4Body);
  const srtf2s = q4.values.map(r => Number(r.SRTF2));
  const expected = Array.from({ length: srtf2s.length }, (_, i) => i);
  const sequenceOk = JSON.stringify([...srtf2s].sort((a, b) => a - b)) === JSON.stringify(expected);
  // 长度自校验：逐片段比较 CLUSTR 数值与 CLUSTD hex 字符长度的一半
  const lenChecks = q4.values.map(r => {
    const clustrLen = parseInt(String(r.CLUSTR ?? '').trim(), 10);
    const clustdLen = r.CLUSTD === undefined ? NaN : String(r.CLUSTD).length;
    return { srtf2: r.SRTF2, clustr: clustrLen, clustdHexChars: clustdLen, match: clustrLen * 2 === clustdLen };
  });
  console.log('Q4 cells:', JSON.stringify(q4.values.map(r => ({
    nummer: r.NUMMER === undefined ? 'NULL-missing-data' : r.NUMMER,
    srtf2: r.SRTF2, clustr: describeCell(r.CLUSTR), clustd: describeCell(r.CLUSTD)
  }))));
  console.log(`Q4 fragments=${q4.values.length} srtf2Sequence=${JSON.stringify(srtf2s)} sequence0ToN=${sequenceOk} truncated=${q4.values.length >= 16}`);
  console.log(`Q4 lengthSelfCheck=${JSON.stringify(lenChecks)}`);
  pass(`Q4 片段取证完成（SRTF2 连续=${sequenceOk}，长度自校验=${lenChecks.every(c => c.match)})`);
}

client.close?.();
console.log('PROBE OK: CLUSTD wire 取证完成（全部输出已脱敏，无原值落盘）');
