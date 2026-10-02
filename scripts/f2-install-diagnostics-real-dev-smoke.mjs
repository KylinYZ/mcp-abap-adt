// F2 真机验收 smoke（sap-demo，全程只读）：
// 深化后的 checkInstallPrerequisites 在真实系统上应报告：
//   ZADT_VSP 对象已部署（installed=true）+ 激活状态核验（SEOCLSRC/REPOSRC）
//   + APC/SICF 服务面探测（404=未配置）→ readiness=service_face_missing
//   （"对象在、服务面未配置：SAPC/SICF 待做"——F2 验收口径）。
// 不做任何写操作。
import { readFileSync } from 'fs';
import adtPkg from '../dist/adt/index.js';
import installDiag from '../dist/adt/InstallDiagnosticsApi.js';
const { ADTClient } = adtPkg;
const { checkInstallPrerequisites } = installDiag;

const envText = readFileSync('C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env', 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）');
  process.exit(1);
}

const client = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
await client.h.login();

const capability = {
  searchObject: (query, objType, max) => client.searchObject(query, objType, max),
  runQuery: (sql, rowNumber, decode) => client.runQuery(sql, rowNumber, decode),
  requestGitRepos: () => client.httpClient.request('/sap/bc/adt/abapgit/repos', {
    method: 'GET',
    headers: { Accept: 'application/abapgit.adt.repos.v2+xml' }
  }),
  // F2 新增探测：APC WebSocket 服务面（404=SAPC/SICF 未配置）
  requestApcService: () => client.httpClient.request('/sap/bc/apc/sap/zadt_vsp', {
    method: 'GET',
    headers: { Accept: 'application/json' }
  })
};

const result = await checkInstallPrerequisites(capability);
console.log(JSON.stringify(result, null, 1));

// F2 验收断言
const helper = result.zadtVspHelper;
let failed = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failed += 1;
}
check(helper.installed === true, 'ZADT_VSP 对象已部署（TADIR 有记录）');
check(helper.objects.length >= 8, `对象清单完整（${helper.objects.length} 个）`);
check(helper.activation?.verified === true, '激活状态核验已执行');
check(helper.serviceFace !== undefined, 'APC/SICF 服务面探测已执行');
check(helper.readiness !== undefined, '人可读就绪结论已输出');
console.log(`readiness: ${helper.readiness?.state} — ${helper.readiness?.detail}`);

await client.h.logout().catch(() => {});
if (failed > 0) process.exit(1);
console.log('F2 SMOKE OK');
