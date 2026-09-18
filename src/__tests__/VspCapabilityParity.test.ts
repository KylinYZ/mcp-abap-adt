import fs from 'fs';
import path from 'path';
import { AbapAdtServer } from '../index';
import { isToolAllowedForSystemRole } from '../config/ToolOperationPolicy';
import { DEFAULT_READONLY_FM_ALLOWLIST } from '../rfc/allowlist';

// 矩阵真源以文件读取（tsconfig 未开 resolveJsonModule，且 docs 在编译根之外）
const MATRIX_PATH = path.resolve(__dirname, '../../docs/evidence/vsp-capability-parity-matrix.json');
const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));

/**
 * VSP 能力对齐矩阵防回退测试。
 *
 * 与 scripts/check-vsp-capability-parity.mjs（静态校验）互补：本测试把矩阵放到
 * 本项目运行时上验证——每个被引用工具都必须真实出现在声明 profile 的运行时
 * catalog 中，并通过系统角色策略；防止矩阵随 catalog 演进后变成失真的静态文档。
 *
 * 本测试不连接 SAP：AbapAdtServer 构造只读取环境变量与构建本地 catalog。
 */

const originalEnvironment = { ...process.env };

const DEV_CATALOG_SERVER_PROFILES = [
  'safe', 'development', 'diagnostic-readonly', 'legacy-full',
  'development-workbench', 'business-readonly', 'operations-readonly'
] as const;

type MatrixRow = {
  id: string;
  domain: string;
  task: string;
  vsp: { surface: string; source: string[]; requires: string[] };
  mcp: {
    status: string;
    taskPath: string[];
    profiles: string[];
    systemRoles: string[];
    restrictionReason: string;
    liftCondition: string;
    alternatePaths?: Array<{ purpose: string; tools: string[]; profiles: string[]; systemRoles: string[] }>;
  };
  priority: string;
  evidence: string[];
  nextMilestone: string;
};

const rows = matrix.rows as MatrixRow[];

function configureServer(role: string, profile: string): AbapAdtServer {
  Object.assign(process.env, {
    SAP_URL: 'https://dev.example.test',
    SAP_USER: 'TEST_USER',
    SAP_PASSWORD: 'not-used',
    SAP_CLIENT: '100',
    SAP_LANGUAGE: 'EN',
    SAP_MCP_SYSTEM_ROLE: role,
    SAP_MCP_TOOL_PROFILE: profile,
    SAP_MCP_ALLOWED_HOSTS: 'dev.example.test',
    SAP_MCP_ALLOWED_CLIENTS: '100',
    SAP_MCP_ALLOWED_NAMESPACES: 'Z,Y'
  });
  return new AbapAdtServer();
}

describe('VSP capability parity matrix anti-regression', () => {
  const devServers = new Map<string, AbapAdtServer>();

  beforeAll(() => {
    // DEV 角色下为全部 profile 各建一个 server，供 catalog 成员验证复用
    for (const profile of DEV_CATALOG_SERVER_PROFILES) {
      devServers.set(profile, configureServer('DEV', profile));
    }
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  function catalogNames(profile: string, role = 'DEV'): Set<string> {
    const server = devServers.get(profile)
      ?? configureServer(role, profile);
    return new Set(((server as any).toolCatalog as Array<{ name: string }>).map(tool => tool.name));
  }

  it('uses unique ids and the frozen status/priority/evidence vocabulary', () => {
    const ids = rows.map(row => row.id);
    expect(new Set(ids).size).toBe(rows.length);
    for (const row of rows) {
      expect(['MCP_SUPERSET', 'EQUIVALENT', 'PARTIAL', 'GAP', 'INTENTIONAL_RESTRICTION', 'UNVERIFIED'])
        .toContain(row.mcp.status);
      expect(['P0', 'P1', 'P2']).toContain(row.priority);
      expect(row.evidence.length).toBeGreaterThan(0);
      expect(row.vsp.source.length).toBeGreaterThan(0);
      expect(row.vsp.surface).toBeTruthy();
    }
  });

  it('records both VSP and project audit baselines (commit + worktree state)', () => {
    // 矩阵必须可追溯：VSP 与本项目的 commit 与工作树状态缺一不可
    expect(matrix.vspRevision).toBe('9886d2727f47506368b0a3c2f1c1766f1200f747');
    expect(String(matrix.vspWorktreeState)).toContain('dirty');
    expect(matrix.projectRevision).toBe('a8cdeda38dc4bbb8a98896e4f42e5925eed3d8ef');
    expect(String(matrix.projectWorktreeState)).toContain('dirty');
  });

  it('proves every referenced task-path tool exists in the declared DEV runtime catalogs', () => {
    const failures: string[] = [];
    for (const row of rows) {
      const { status, taskPath, profiles } = row.mcp;
      if (taskPath.length === 0) continue;
      for (const profile of profiles) {
        const catalog = catalogNames(profile);
        for (const tool of taskPath) {
          if (!catalog.has(tool)) failures.push(`${row.id}: '${tool}' 不在 DEV ${profile} 运行时 catalog 中`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('proves every alternate-path tool exists in its declared DEV runtime catalogs', () => {
    const failures: string[] = [];
    for (const row of rows) {
      for (const alt of row.mcp.alternatePaths ?? []) {
        for (const profile of alt.profiles) {
          const catalog = catalogNames(profile);
          for (const tool of alt.tools) {
            if (!catalog.has(tool)) failures.push(`${row.id}: alternate '${tool}' 不在 DEV ${profile} catalog 中`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it.each(['QAS', 'PRD'])('keeps every declared read path usable for role %s by policy and catalog', role => {
    const failures: string[] = [];
    for (const row of rows) {
      const { taskPath, profiles, systemRoles } = row.mcp;
      if (taskPath.length === 0 || !systemRoles.includes(role)) continue;
      for (const tool of taskPath) {
        if (!isToolAllowedForSystemRole(tool, role)) failures.push(`${row.id}: '${tool}' 策略上不允许角色 ${role}`);
      }
      // 抽验只读入口 profile 的真实 QAS/PRD catalog：catalog 过滤与策略必须一致
      for (const profile of ['business-readonly', 'operations-readonly', 'development-workbench']) {
        if (!profiles.includes(profile)) continue;
        const catalog = catalogNames(profile, role);
        for (const tool of taskPath) {
          if (!catalog.has(tool)) failures.push(`${row.id}: '${tool}' 不在 ${role} ${profile} 运行时 catalog 中`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('requires task paths, profiles, and roles for every EQUIVALENT or MCP_SUPERSET row', () => {
    for (const row of rows) {
      if (row.mcp.status !== 'EQUIVALENT' && row.mcp.status !== 'MCP_SUPERSET') continue;
      expect(row.mcp.taskPath.length).toBeGreaterThan(0);
      expect(row.mcp.profiles.length).toBeGreaterThan(0);
      expect(row.mcp.systemRoles.length).toBeGreaterThan(0);
    }
  });

  it('requires reason and lift condition on every INTENTIONAL_RESTRICTION row', () => {
    const restricted = rows.filter(row => row.mcp.status === 'INTENTIONAL_RESTRICTION');
    expect(restricted.length).toBeGreaterThan(0);
    for (const row of restricted) {
      expect(row.mcp.restrictionReason).toBeTruthy();
      expect(row.mcp.liftCondition).toBeTruthy();
    }
  });

  it('requires a next milestone on every P0 gap so unowned holes cannot linger', () => {
    // P0 GAP 已全部关闭（第 2026-09-18 轮 callRfm 泛化）；红线保持：
    // 未来任何新 P0 GAP 必须携带 nextMilestone，不得出现无主缺口
    const p0Gaps = rows.filter(row => row.priority === 'P0' && row.mcp.status === 'GAP');
    for (const row of p0Gaps) expect(row.nextMilestone).toBeTruthy();
  });

  it('requires PARTIAL rows to state their uncovered boundary', () => {
    for (const row of rows.filter(item => item.mcp.status === 'PARTIAL')) {
      expect(row.mcp.restrictionReason).toBeTruthy();
    }
  });

  it('keeps the rfc data plane allowlist-gated now that the transport exists', () => {
    // 防回退红线（2026-09-18 callRfm 泛化后改写）：RFC 数据面已 EQUIVALENT，
    // 但"任意 FM 调用"永不开口——call/describe 必须有任务路径且真机验证，
    // 默认 allowlist 只能含 SAP 标准只读系统 RFM（RFC_* 前缀），禁止业务
    // 自定义/Z* FM 静默混入默认集合
    for (const [id, tool] of [
      ['rfc.remote-enabled.call', 'callRfm'],
      ['rfc.remote-enabled.describe', 'describeRfm']
    ] as const) {
      const row = rows.find(item => item.id === id);
      expect(row).toBeDefined();
      expect(row?.mcp.status).toBe('EQUIVALENT');
      expect(row?.mcp.taskPath).toContain(tool);
      expect(row?.evidence).toContain('real-dev-verified');
      expect(row?.priority).toBe('P0');
    }
    for (const entry of DEFAULT_READONLY_FM_ALLOWLIST) {
      expect(entry.startsWith('RFC_')).toBe(true);
    }
    const bridge = rows.find(item => item.id === 'rfc.helper-bridge');
    expect(bridge?.mcp.status).toBe('INTENTIONAL_RESTRICTION');
    // helper bridge 不得被描述为“无 SAP 端前置条件”
    expect(String(bridge?.vsp.requires.join(' '))).toMatch(/SAP 端/);
    expect(String(bridge?.mcp.restrictionReason)).toMatch(/SAP 端前置条件|helper/);
  });

  it('never marks controlled DDIC creation as a gap', () => {
    // 防误标红线：DDIC Domain/Data Element 等受控创建已 REAL_DEV_VERIFIED，不得标为缺口
    const creation = rows.find(item => item.id === 'crud.create-object');
    expect(creation?.mcp.status).toBe('MCP_SUPERSET');
    expect(creation?.mcp.taskPath).toEqual(expect.arrayContaining([
      'previewRepositoryObjectCreation', 'applyRepositoryObjectCreation', 'getRepositoryObjectCreationStatus'
    ]));
    expect(creation?.evidence).toContain('real-dev-verified');

    const cleanup = rows.find(item => item.id === 'crud.delete-object');
    expect(cleanup?.mcp.status).toBe('MCP_SUPERSET');
    expect(['GAP', 'INTENTIONAL_RESTRICTION']).not.toContain(cleanup?.mcp.status);
  });

  it('covers the VSP universal action families and the focused entry tool', () => {
    // 覆盖面防回退：VSP universal 路由的每个 action 族至少有一行对照；
    // 若 VSP 新增 action 族而矩阵没有对应新行，此断言应提醒补行。
    const requiredDomains = [
      'source', 'read', 'search', 'codeintel', 'devtools', 'crud', 'transport',
      'rfc', 'debug', 'report', 'diagnostics', 'analysis', 'git', 'install',
      'fileio', 'ui5', 'i18n', 'revisions', 'service-binding', 'system'
    ];
    const presentDomains = new Set(rows.map(row => row.domain));
    for (const domain of requiredDomains) expect(presentDomains.has(domain)).toBe(true);
    // RFC 必须同时覆盖 direct RFC 与 helper bridge 两行
    expect(rows.some(row => row.id === 'rfc.remote-enabled.call')).toBe(true);
    expect(rows.some(row => row.id === 'rfc.helper-bridge')).toBe(true);
  });
});
