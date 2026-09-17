/**
 * 受控激活 MCP 工具处理器测试（SafeActivationHandlers）。
 *
 * 覆盖点：
 * - 工具定义：previewObjectActivation / applyObjectActivation /
 *   getObjectActivationStatus 的注解与确认标记。
 * - 分发：preview/status 不触发执行；applyObjectActivation 只走 MCP form
 *   elicitation 原生确认（拒绝调用方布尔确认、无确认能力直接拒绝）。
 * - profile/role 门控（configureServer 模式，全部 mock/本地，不连接 SAP）：
 *   QAS/PRD/缺失/未知角色下三工具从 catalog 隐藏且 dispatch 拒绝 POLICY_DENIED；
 *   DEV 的 development 与 development-workbench 可见；
 *   safe/business-readonly/diagnostic-readonly/legacy-full 不可见；
 *   legacy-full 即使 DEV 也被 dispatch 拒绝（专家继续用原子激活工具）。
 */
import { AbapAdtServer } from '../index';
import { SafeActivationHandlers } from '../handlers/SafeActivationHandlers';
import type { ObjectActivationPlanView } from '../safe/objectActivationTypes.js';

const originalEnvironment = { ...process.env };

/** 与 ToolCatalogIntegrity 相同的服务器配置模式（仅本地构造，不连接 SAP）。 */
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

/** 受控激活三工具名。 */
const ACTIVATION_TOOL_NAMES = [
  'previewObjectActivation', 'applyObjectActivation', 'getObjectActivationStatus'
];

/** 构造可确认的 plan 视图（apply 确认链的 status 端口返回值）。 */
function previewedPlan(): ObjectActivationPlanView {
  return {
    activationPlanId: 'activation-1',
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'PREVIEWED',
    systemHost: 'dev.example.test',
    client: '100',
    sapUser: 'DEVUSER',
    systemRole: 'DEV',
    toolProfile: 'development-workbench',
    objects: [{
      objectType: 'CLAS/OC', objectName: 'ZCL_ALPHA',
      objectUri: '/sap/bc/adt/oo/classes/zcl_alpha', parentUri: '/sap/bc/adt/packages/zpkg'
    }],
    payloadHash: 'a'.repeat(64),
    stages: [],
    confirmationMode: 'elicitation'
  };
}

function setupHandlers(overrides: Record<string, unknown> = {}) {
  const workflow = {
    preview: jest.fn().mockResolvedValue({ status: 'preview', confirmationRequired: true, plan: previewedPlan() }),
    status: jest.fn().mockReturnValue(previewedPlan()),
    ...overrides
  };
  const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success', plan: { status: 'SUCCEEDED' } });
  const handlers = new SafeActivationHandlers(workflow as never, {
    supportsFormElicitation: () => true,
    elicitInput: jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'activate' } }),
    applyConfirmed
  });
  return { handlers, workflow, applyConfirmed };
}

describe('SafeActivationHandlers', () => {
  it('exposes exactly three bounded activation tools with correct hints', () => {
    const { handlers } = setupHandlers();
    expect(handlers.getTools().map(tool => tool.name)).toEqual(ACTIVATION_TOOL_NAMES);
    expect(handlers.getTools()).toEqual([
      expect.objectContaining({ name: 'previewObjectActivation', annotations: expect.objectContaining({ readOnlyHint: true }) }),
      expect.objectContaining({
        name: 'applyObjectActivation',
        annotations: expect.objectContaining({ readOnlyHint: false }),
        _meta: expect.objectContaining({ approvalRequired: true })
      }),
      expect.objectContaining({ name: 'getObjectActivationStatus', annotations: expect.objectContaining({ readOnlyHint: true }) })
    ]);
    expect(handlers.supports('previewObjectActivation')).toBe(true);
    expect(handlers.supports('activateObjects')).toBe(false);
  });

  it('dispatches preview and status without executing any activation', async () => {
    const { handlers, workflow, applyConfirmed } = setupHandlers();

    await handlers.handle('previewObjectActivation', { objectNames: ['ZCL_ALPHA'] });
    await handlers.handle('getObjectActivationStatus', { activationPlanId: 'activation-1' });

    expect(workflow.preview).toHaveBeenCalledWith({ objectNames: ['ZCL_ALPHA'] });
    expect(workflow.status).toHaveBeenCalledWith('activation-1');
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('runs apply only after a native elicitation accept', async () => {
    const { handlers, applyConfirmed } = setupHandlers();

    const result = await handlers.handle('applyObjectActivation', { activationPlanId: 'activation-1' });

    expect(applyConfirmed).toHaveBeenCalledWith('activation-1');
    expect(result).toMatchObject({ status: 'success' });
  });

  it('returns confirmation_declined when the client cancels the native dialog', async () => {
    const { handlers, applyConfirmed } = setupHandlers();
    // 通过重新构造注入取消应答
    const declining = new SafeActivationHandlers(
      { preview: jest.fn(), status: jest.fn().mockReturnValue(previewedPlan()) } as never,
      {
        supportsFormElicitation: () => true,
        elicitInput: jest.fn().mockResolvedValue({ action: 'cancel' }),
        applyConfirmed
      }
    );

    const result = await declining.handle('applyObjectActivation', { activationPlanId: 'activation-1' });

    expect(result).toMatchObject({ status: 'confirmation_declined', activationPlanId: 'activation-1' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('rejects apply entirely when the client cannot do form elicitation', async () => {
    const handlers = new SafeActivationHandlers(
      { preview: jest.fn(), status: jest.fn().mockReturnValue(previewedPlan()) } as never,
      {
        supportsFormElicitation: () => false,
        elicitInput: jest.fn(),
        applyConfirmed: jest.fn()
      }
    );

    await expect(handlers.handle('applyObjectActivation', { activationPlanId: 'activation-1' }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_UNSUPPORTED' });
  });

  it.each(['QAS', 'PRD', '', 'UNKNOWN'])('hides and rejects controlled activation for role %p', async role => {
    const server = configureServer(role, 'development');
    const handlers = (server as any).safeActivationHandlers;
    const handle = jest.spyOn(handlers, 'handle');

    // 三工具全部从 catalog 隐藏
    expect((server as any).toolCatalog.map((tool: { name: string }) => tool.name))
      .toEqual(expect.not.arrayContaining(ACTIVATION_TOOL_NAMES));
    // preview（read-only 语义）同样被拒：激活链在非 DEV 角色整体不可用
    await expect((server as any).dispatchTool('previewObjectActivation', {}))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect((server as any).dispatchTool('applyObjectActivation', { activationPlanId: 'forged-plan' }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('exposes controlled activation to DEV development and development-workbench only', () => {
    for (const profile of ['development', 'development-workbench']) {
      const names = (configureServer('DEV', profile) as any).toolCatalog.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(expect.arrayContaining(ACTIVATION_TOOL_NAMES));
    }
    for (const profile of ['safe', 'diagnostic-readonly', 'legacy-full', 'business-readonly', 'operations-readonly']) {
      const names = (configureServer('DEV', profile) as any).toolCatalog.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(expect.not.arrayContaining(ACTIVATION_TOOL_NAMES));
    }
  });

  it('rejects controlled activation in DEV legacy-full despite the atomic fallback tools', async () => {
    const server = configureServer('DEV', 'legacy-full');
    const handlers = (server as any).safeActivationHandlers;
    const handle = jest.spyOn(handlers, 'handle');

    // 专家 profile 不进入受控激活链：catalog 不含且 dispatch 拒绝
    expect((server as any).toolCatalog.map((tool: { name: string }) => tool.name))
      .toEqual(expect.not.arrayContaining(ACTIVATION_TOOL_NAMES));
    await expect((server as any).dispatchTool('applyObjectActivation', { activationPlanId: 'forged-plan' }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(handle).not.toHaveBeenCalled();
  });
});
