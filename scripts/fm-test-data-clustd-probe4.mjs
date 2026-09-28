// EUFUNC 多片段（SRTF2 续块）完整性取证（阶段 B 四段，只读，2 次 datapreview 查询）：
// Q1 定位 srtf2>=2 的续块候选（只取键列）；Q2 对首个候选做片段取证——
// SRTF2 序列完整性、CLUSTR/CLUSTD 长度自校验、组装器重组、decoder 解码尝试。
// 隐私纪律同前：单元格只输出长度/字符集/指纹，原值与字段值零落盘。
import { resolve } from 'path';
import { readFileSync } from 'fs';
import adtPkg from '../dist/adt/index.js';
const { ADTClient } = adtPkg;
import tablePkg from '../dist/adt/api/tablecontents.js';
const { parseQueryResponse } = tablePkg;
import protoPkg from '../dist/adt/EufuncV5DecoderPrototype.js';
const { decodeEufuncV5Prototype, assembleEufuncV5ClusterFragments } = protoPkg;

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

const q = v => (v === undefined ? { form: 'undefined' } : typeof v === 'object'
  ? { form: 'object', keys: Object.keys(v) }
  : { length: String(v).length, fingerprint: String(v).length > 64 ? undefined : undefined, preview: String(v).length <= 40 ? String(v) : undefined });

// Q1：找多片段候选（srtf2>=2 意味着该 FM+集号至少有第 3 个续块）。
// datapreview 对 ORDER BY 支持不稳（真机已知缺陷），不做排序，客户端侧挑样本。
const q1Body = await rawFreestyle(
  `SELECT name, nummer, srtf2 FROM eufunc WHERE relid = 'FL' AND srtf2 > 1`, 8);
const q1 = parseQueryResponse(q1Body);
const candidates = q1.values.map(r => ({
  name: typeof r.NAME === 'string' ? r.NAME.trim() : r.NAME,
  nummer: typeof r.NUMMER === 'string' ? r.NUMMER.trim() : r.NUMMER,
  srtf2: r.SRTF2
}));
console.log(`Q1 candidates(${q1.values.length}):`, JSON.stringify(candidates));
if (candidates.length === 0) {
  console.log('INFO 目标 DEV 的 EUFUNC 中无 srtf2>1 的集群——多片段样本不存在，保持 partial');
  client.close?.();
  process.exit(0);
}

// Q2：首个候选的完整片段取证。可能命中业务 FM 的测试数据——单元格只取
// 长度/指纹，对象名清单与结构计数可输出，字段值绝不输出。
const first = candidates[0];
if (typeof first.name !== 'string' || !/^[A-Z0-9_]+$/.test(first.name)) {
  console.log(`INFO 候选 name 形态异常（${JSON.stringify(first.name)}），不扩大取证，保持 partial`);
  client.close?.();
  process.exit(0);
}
const nummer = typeof first.nummer === 'string' && /^[A-Z0-9_]+$/.test(first.nummer) ? first.nummer : null;
const q2Sql = `SELECT srtf2, clustr, clustd FROM eufunc WHERE relid = 'FL' AND name = '${first.name}'` +
  (nummer ? ` AND nummer = '${nummer}'` : '');
const q2Body = await rawFreestyle(q2Sql, 16);
const q2 = parseQueryResponse(q2Body);
const srtf2s = q2.values.map(r => Number(String(r.SRTF2 ?? '').trim()));
const expected = Array.from({ length: srtf2s.length }, (_, i) => i);
const sequenceOk = JSON.stringify([...srtf2s].sort((a, b) => a - b)) === JSON.stringify(expected);
console.log(`Q2 fragments=${q2.values.length} srtf2Sequence=${JSON.stringify(srtf2s)} sequence0ToN=${sequenceOk} truncated=${q2.values.length >= 16}`);
console.log('Q2 cells:', JSON.stringify(q2.values.map(r => ({
  srtf2: r.SRTF2,
  clustr: typeof r.CLUSTR === 'string' ? r.CLUSTR.trim() : q(r.CLUSTR),
  clustdLen: r.CLUSTD === undefined ? null : String(r.CLUSTD).length,
  clustdEven: r.CLUSTD === undefined ? null : String(r.CLUSTD).length % 2 === 0,
  clustdHex: r.CLUSTD === undefined ? null : /^[0-9a-fA-F]*$/.test(String(r.CLUSTD))
}))));
if (!sequenceOk) {
  console.log('INFO SRTF2 序列不连续（缺片/重复/超 cap）——完整性策略的现实样本，保持如实记录');
} else {
  // 组装器重组 + decoder 解码尝试（对象名清单可输出，字段值不输出）
  try {
    const assembled = assembleEufuncV5ClusterFragments(q2.values.map(r => ({
      srtf2: Number(String(r.SRTF2).trim()),
      clustrBytes: parseInt(String(r.CLUSTR ?? '').trim(), 10),
      clustdHex: String(r.CLUSTD ?? '')
    })));
    console.log(`Q2 assembled: bytes=${assembled.bytes.length} fragments=${assembled.fragmentCount} fallback=${JSON.stringify(assembled.lengthFallbackFragments)}`);
    try {
      const decoded = decodeEufuncV5Prototype(assembled.bytes);
      console.log('Q2 decode: OK objects=', JSON.stringify(decoded.objects.map(o => ({
        name: o.name, kind: o.kind, rows: o.rows.length, fields: o.fields.length
      }))));
    } catch (de) {
      console.log(`Q2 decode: REJECTED (${String(de?.message || de).slice(0, 120)})`);
    }
  } catch (ae) {
    console.log(`Q2 assemble: REJECTED (${String(ae?.message || ae).slice(0, 120)})`);
  }
}

client.close?.();
console.log('PROBE4 DONE');
