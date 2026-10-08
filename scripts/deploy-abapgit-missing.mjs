// abapGit v1.134.0 缺失对象批量部署引擎（sap-dev $ABAPGIT 包，所有者授权轮）。
// 流程：逐对象 create（已存在则跳过创建）→ lock → PUT source → unLock；
// 创建阶段不逐个激活——末尾激活收敛循环（依赖未激活导致的失败在下一轮重试，
// preauditRequested=true，最多 8 轮），与所有者部署轮方法论一致。
// 源：D:/MyDev/SAP/tmp-abapgit/extracted/abapGit-main（v1.134.0，已核与实装同源）。
// 用法：node scripts/deploy-abapgit-missing.mjs [--limit=N] [--activate-only]
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ADTClient } from '../dist/adt/index.js';
import { createObject } from '../dist/adt/api/objectcreator.js';
import { lock, unLock, setObjectSource } from '../dist/adt/api/objectcontents.js';
import pkgActivate from '../dist/adt/api/activate.js';
const activate = pkgActivate.activate ?? pkgActivate.default ?? pkgActivate;

const SRC_ROOT = 'D:/MyDev/SAP/tmp-abapgit/extracted/abapGit-main';
const PACKAGE = '$ABAPGIT';
const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const ACTIVATE_ONLY = args.includes('--activate-only');

const envText = readFileSync('C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env', 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.255.42')) {
  console.error('红线预检失败：SAP_URL 不是 sap-dev');
  process.exit(1);
}

/** 递归找对象的源码文件（PREFIX 文件夹逻辑：src/<前缀路径>/<name>.<type>.abap）。 */
function findSource(name, ext) {
  const target = `${name}.${ext}`;
  const walk = dir => {
    let out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out = out.concat(walk(p));
      else if (e.name.toLowerCase() === target.toLowerCase()) out.push(p);
    }
    return out;
  };
  const hits = walk(SRC_ROOT + '/src');
  // test/ 目录排除（本地测试源不部署）
  return hits.filter(p => { const lp = p.toLowerCase().replaceAll(String.fromCharCode(92), '/'); return !lp.includes('/test/'); });
}

const missing = JSON.parse(readFileSync('docs/evidence/sap-dev-backups/abapgit-deploy-missing.json', 'utf8')).missing;
const deployable = missing.filter(([t]) => t === 'CLAS' || t === 'INTF' || t === 'PROG');
console.log(`deployable objects: ${deployable.length} (CLAS ${deployable.filter(x => x[0] === 'CLAS').length}, INTF ${deployable.filter(x => x[0] === 'INTF').length}, PROG ${deployable.filter(x => x[0] === 'PROG').length})`);

const EXT = { CLAS: 'clas.abap', INTF: 'intf.abap', PROG: 'prog.abap' };
const OBJTYPE = { CLAS: 'CLAS/OC', INTF: 'INTF/OI', PROG: 'PROG/P' };
const results = { created: 0, exists: 0, written: 0, failedCreate: [], failedWrite: [] };

const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
raw.stateful = 'stateful';
await raw.h.login();
console.log('ADT session ready');

function objectUrl(type, name) {
  if (type === 'PROG') return `/sap/bc/adt/programs/programs/${name.toLowerCase()}`;
  if (type === 'INTF') return `/sap/bc/adt/oo/interfaces/${name.toLowerCase()}`;
  return `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
}

if (!ACTIVATE_ONLY) {
  let done = 0;
  for (const [type, name] of deployable) {
    if (done >= LIMIT) break;
    done += 1;
    const sources = findSource(name, EXT[type]);
    if (sources.length === 0) {
      results.failedCreate.push({ type, name, stage: 'source-missing' });
      console.log(`SKIP-NOSRC ${type} ${name}`);
      continue;
    }
    const source = readFileSync(sources[0], 'utf8');
    const url = objectUrl(type, name);
    try {
      await createObject(raw.h, {
        objtype: OBJTYPE[type], name, parentName: PACKAGE,
        description: 'abapGit v1.134.0 deploy', contentType: 'application/*'
      });
      results.created += 1;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/already exists|duplicate/i.test(msg)) {
        results.exists += 1;
      } else {
        results.failedCreate.push({ type, name, stage: 'create', error: msg.slice(0, 200) });
        console.log(`FAIL-CREATE ${type} ${name}: ${msg.slice(0, 120)}`);
        continue;
      }
    }
    // 锁写源码（已存在对象同样覆写源码，保证版本一致）
    try {
      const lockRes = await lock(raw.h, url, 'MODIFY');
      const handle = String(lockRes.LOCK_HANDLE ?? lockRes.lockHandle ?? '');
      if (!handle) throw new Error('no lock handle');
      try {
        await setObjectSource(raw.h, `${url}/source/main`, source, handle);
        results.written += 1;
      } finally {
        await unLock(raw.h, url, handle).catch(() => {});
      }
    } catch (e) {
      results.failedWrite.push({ type, name, stage: 'write', error: String(e?.message ?? e).slice(0, 200) });
      console.log(`FAIL-WRITE ${type} ${name}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    if (done % 20 === 0) console.log(`progress ${done}/${deployable.length} (created ${results.created}, exists ${results.exists}, written ${results.written})`);
  }
  console.log(`deploy pass done: created=${results.created} exists=${results.exists} written=${results.written} failCreate=${results.failedCreate.length} failWrite=${results.failedWrite.length}`);
}

// 激活收敛循环：对全部部署对象激活，依赖未激活导致的失败下一轮重试
const pending = deployable.map(([type, name]) => ({ type, name, url: objectUrl(type, name) }));
let activatedTotal = 0;
let stillInactive = pending;
for (let round = 1; round <= 8 && stillInactive.length > 0; round += 1) {
  const nextRound = [];
  for (const obj of stillInactive) {
    try {
      const act = await activate(raw.h, obj.name, obj.url, true);
      const errors = (act?.messages ?? []).filter(m => ['E', 'A'].includes((m.type ?? m.severity ?? '').toUpperCase()));
      if (errors.length > 0 || act?.success === false) {
        nextRound.push(obj); // 依赖未激活等——下一轮重试
      } else {
        activatedTotal += 1;
      }
    } catch (e) {
      nextRound.push(obj);
    }
  }
  console.log(`activate round ${round}: +${activatedTotal} ok, ${nextRound.length} pending`);
  if (stillInactive.length === nextRound.length) {
    console.log('no progress this round — stopping convergence');
    stillInactive = nextRound;
    break;
  }
  stillInactive = nextRound;
}
if (stillInactive.length > 0) {
  console.log('STILL-INACTIVE:');
  for (const obj of stillInactive.slice(0, 20)) console.log('  ', obj.type, obj.name);
}
console.log(`FINAL: activated=${activatedTotal}, inactive=${stillInactive.length}`);
await raw.h.logout().catch(() => {});
process.exit(0);
