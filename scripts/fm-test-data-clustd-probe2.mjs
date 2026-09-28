// EUFUNC CLUSTD 补充取证（阶段 B 二段，只读，单次 datapreview 查询）：
// 1) 验证 padding 模型——CLUSTD 按 LRAW 宽度全额返回（含 0x00 padding），
//    有效字节数 = CLUSTR(INT2)；拼接规则 = 每片段取前 CLUSTR×2 个 hex 字符。
// 2) 用隔离原型 decoder（EufuncV5DecoderPrototype，未接入生产）对真机 payload
//    做只读解码尝试——输出仅对象名/结构类别/字节数；任何字段值不打印。
import { resolve } from 'path';
import { readFileSync } from 'fs';
import adtPkg from '../dist/adt/index.js';
const { ADTClient } = adtPkg;
import tablePkg from '../dist/adt/api/tablecontents.js';
const { parseQueryResponse } = tablePkg;
import protoPkg from '../dist/adt/EufuncV5DecoderPrototype.js';
const { decodeEufuncV5Prototype } = protoPkg;

const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envVars = {};
for (const line of readFileSync(resolve(ENV_PATH), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2];
}
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）');
  process.exit(1);
}

const client = new ADTClient(
  envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD,
  envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN'
);

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

const FM = 'C162_SPEC_GET_BY_ID';
const body = await rawFreestyle(
  `SELECT srtf2, clustr, clustd FROM eufunc WHERE relid = 'FL' AND name = '${FM}' AND nummer = '999'`, 1);

// wire → bytes：按 CLUSTR trim padding，然后逐项验证
const { values } = parseQueryResponse(body);
const row = values[0];
if (!row || row.CLUSTD === undefined) { console.error('FAIL 未取得 CLUSTD 单元格'); process.exit(1); }
const fullHex = String(row.CLUSTD);
const clustrBytes = parseInt(String(row.CLUSTR ?? '').trim(), 10);
const effectiveHex = fullHex.slice(0, clustrBytes * 2);
const paddingHex = fullHex.slice(clustrBytes * 2);
const paddingAllZeros = /^0*$/.test(paddingHex);
console.log(JSON.stringify({
  step: 'padding-model',
  fullHexChars: fullHex.length,
  clustrBytes,
  effectiveHexChars: effectiveHex.length,
  paddingHexChars: paddingHex.length,
  paddingAllZeros,
  trailingNonZeroSample: paddingAllZeros ? undefined :
    [...new Set(paddingHex.replace(/0/g, ''))].slice(0, 8)
}));

// 真机 payload 过隔离原型 decoder（V5 白名单子集；fail-closed 拒绝也是有效证据）
try {
  const bytes = new Uint8Array(Buffer.from(effectiveHex, 'hex'));
  const cluster = decodeEufuncV5Prototype(bytes);
  // 只输出对象名/结构类别/行数与字节数——TE_DATADIR 标题等字段值不打印
  console.log(JSON.stringify({
    step: 'prototype-decode',
    result: 'OK',
    version: cluster.version, codepage: cluster.codepage,
    compressed: cluster.compressed, algorithm: cluster.algorithm ?? 'plain',
    objects: cluster.objects.map(o => ({
      name: o.name, kind: o.kind, typeCode: o.typeCode,
      rowLength: o.rowLength, rows: o.rows.length,
      fields: o.fields.length
    }))
  }, null, 1));
  console.log('PASS 真机 payload 通过原型 decoder 解码（对象名/结构清单如上，字段值未读取）');
} catch (e) {
  console.log(JSON.stringify({ step: 'prototype-decode', result: 'REJECTED', reason: String(e?.message || e).slice(0, 160) }));
  console.log('INFO 原型未覆盖该集群形态（fail-closed 如实记录，不代表 payload 不可解码）');
}

client.close?.();
console.log('PROBE2 OK');
