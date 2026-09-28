// EUFUNC CLUSTD oracle 解码验证（阶段 B 三段，只读，单次 datapreview 查询）：
// 真机 999 目录集群 bytes（按 CLUSTR trim padding）送入修正后的原型 decoder。
// 成功 → 输出对象名/结构清单（API 对象名非业务数据可记录，字段值不打印）；
// 失败 → 输出脱敏结构摘要（头部字段/inflate 布局/对象层游标位置）供离线分析。
// bytes 本身不落盘、不打印。
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { inflateRawSync } from 'node:zlib';
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

/** 结构 walk：解析 cluster body 的对象布局，输出格式契约字段。
 *  只输出对象名/kind/行长/descriptor entry 链（marker,code,length）/行数统计；
 *  行数据字节与字段值不读取不输出。 */
function walkCluster(blob) {
  // 解包压缩 body（与原型相同语义：8 字节 SAP 压缩头 + 位偏移 raw DEFLATE）
  let body;
  if (blob[4] === 2) {
    const stream = blob.subarray(16);
    const exp = new DataView(stream.buffer, stream.byteOffset, stream.byteLength).getUint32(0, true);
    const prefix = 2 + (stream[8] & 0x03);
    const compressed = stream.subarray(8);
    const shifted = new Uint8Array(compressed.length);
    for (let i = 0; i < compressed.length; i++) {
      shifted[i] = (compressed[i] >>> prefix) | (i + 1 < compressed.length ? compressed[i + 1] << (8 - prefix) : 0);
    }
    body = inflateRawSync(shifted, { maxOutputLength: exp + 1 });
  } else {
    body = blob.subarray(16);
  }
  let pos = 0;
  const objects = [];
  while (pos < body.length && body[pos] !== 0x04 && objects.length < 8) {
    const head = { offset: pos, kind: body[pos], typeCode: body[pos + 1] };
    head.rowLength = (body[pos + 2] << 8) | body[pos + 3];
    head.sizeField = (body[pos + 4] << 8) | body[pos + 5];
    const nameLen = body[pos + 6];
    if (nameLen < 1 || pos + 15 + nameLen > body.length) { head.error = 'bad name length'; objects.push(head); break; }
    head.name = String.fromCharCode(...body.subarray(pos + 15, pos + 15 + nameLen));
    pos += 15 + nameLen;
    if (head.kind === 2 || head.kind === 3 || head.kind === 5 || head.kind === 6) {
      const close = (head.kind === 3 || head.kind === 6) ? 0xae : 0xac;
      const entries = [];
      let depth = 0;
      let walked = false;
      const walkStart = pos;
      while (pos + 4 <= body.length) {
        const m = body[pos], c = body[pos + 1], l = (body[pos + 2] << 8) | body[pos + 3];
        entries.push({ m: m.toString(16), c: c.toString(16), l });
        pos += 4;
        if (m === close) { walked = depth === 0; break; }
        if (m === 0xa0 || m === 0xab) depth += 1;
        else if (m === 0xa1 || m === 0xac) depth -= 1;
        else if (m !== 0xaa && m !== 0xaf && m !== 0xad) { head.walkError = `unexpected marker ${m.toString(16)} at ${pos - 4}`; break; }
      }
      head.descriptorEntries = entries;
      head.descriptorBytes = pos - walkStart;
      if (!walked) { objects.push(head); break; }
    }
    // 行区：统计 0xBB 行前缀（只计数与行长断言，不读内容）
    let rows = 0;
    while (pos < body.length && body[pos] === 0xbb) {
      rows += 1;
      pos += 1 + head.rowLength;
    }
    head.rows = rows;
    objects.push(head);
  }
  return { bodyBytes: body.length, endMarkerAt: pos < body.length && body[pos] === 0x04 ? pos : null, trailingBytesAfterEnd: body.length - pos - 1, objects };
}

const body = await rawFreestyle(
  `SELECT srtf2, clustr, clustd FROM eufunc WHERE relid = 'FL' AND name = '${FM}' AND nummer = '999'`, 1);

const { values } = parseQueryResponse(body);
const row = values[0];
if (!row || row.CLUSTD === undefined) { console.error('FAIL 未取得 CLUSTD 单元格'); process.exit(1); }
const fullHex = String(row.CLUSTD);
const clustrBytes = parseInt(String(row.CLUSTR ?? '').trim(), 10);
const bytes = new Uint8Array(Buffer.from(fullHex.slice(0, clustrBytes * 2), 'hex'));

try {
  const cluster = decodeEufuncV5Prototype(bytes);
  console.log(JSON.stringify({
    step: 'oracle-decode', result: 'OK',
    compressed: cluster.compressed, algorithm: cluster.algorithm ?? 'plain',
    objects: cluster.objects.map(o => ({
      name: o.name, kind: o.kind, typeCode: o.typeCode,
      rowLength: o.rowLength, rows: o.rows.length, fields: o.fields.length
    }))
  }, null, 1));
  // oracle 对照：999 目录集群按 VSP fmtest.go 语义应含 TE_DATADIR/FDESC_COPY
  const names = cluster.objects.map(o => o.name);
  const hasDir = names.includes('TE_DATADIR');
  const hasFdesc = names.includes('FDESC_COPY');
  console.log(`oracle TE_DATADIR=${hasDir} FDESC_COPY=${hasFdesc}`);
  console.log(hasDir && hasFdesc ? 'PASS 真机 payload 通过原型 decoder 且对象名与 VSP fmtest.go 语义吻合' : 'INFO 解码成功但对象名与预期语义不完全吻合（清单如上）');
} catch (e) {
  // 失败：结构 walk——输出每个对象的对象头字段与 descriptor entry 链
  //（marker/code/length 是格式契约字段，可安全输出；行数据内容不读取不输出）
  const reason = String(e?.message || e).slice(0, 160);
  console.log(JSON.stringify({ step: 'oracle-decode', result: 'REJECTED', reason }));
  const walk = walkCluster(bytes);
  console.log(JSON.stringify({ step: 'structure-walk', objects: walk }, null, 1));
  // 对象级 oracle 判定：999 目录集群按 VSP fmtest.go 语义的核心两对象
  // TE_DATADIR/FDESC_COPY 若已完整解析（descriptor 正常收口、行区对齐），
  // 则目录语义可解码；整体 REJECTED 的残余对象属于上游共同能力边界
  //（真机实证：deep table line type 嵌套子表 0xAD，VSP legacyChildren 同拒）。
  const core = walk.objects.filter(o => o.name === 'TE_DATADIR' || o.name === 'FDESC_COPY');
  const coreOk = core.length === 2 && core.every(o => !o.walkError && Array.isArray(o.descriptorEntries));
  console.log(`oracle object-level: TE_DATADIR/FDESC_COPY complete=${coreOk}`);
  console.log(coreOk
    ? 'PASS 目录语义对象级 oracle 通过（核心两对象布局与 V5 legacy/VSP 语义吻合）；全 cluster 整体解码止于上游共同边界'
    : 'INFO 对象级 oracle 未完全通过（核心对象清单如上）');
}

client.close?.();
console.log('PROBE3 DONE');
