/**
 * 受控对象激活工作流测试（ObjectActivationWorkflow）。
 *
 * 覆盖点（全部 mock adtclient，绝不连接真实 SAP）：
 * - preview：只读收集候选（跳过 deleted 与 transport-only 条目）、生成 immutable
 *   plan（planId、上下文、payloadHash、TTL）、可选 objectNames 过滤、
 *   无候选/超上限/未知字段的边界行为；preview 阶段绝不调用 activate。
 * - apply：确认后精确调用 activate 一次；重复 apply、未知 plan、过期 plan 拒绝。
 * - 激活异常或 success=false：plan 置 UNKNOWN_OUTCOME 并停止，绝不重试。
 */
import { SafetyPolicy } from '../safe/SafetyPolicy';
import { ObjectActivationPlanStore } from '../safe/ObjectActivationPlanStore';
import { ObjectActivationWorkflow } from '../safe/ObjectActivationWorkflow';
import type { InactiveObjectRecord } from '../adt/index.js';
import type { ObjectActivationPreviewResult, PreviewObjectActivationInput } from '../safe/objectActivationTypes.js';

/**
 * preview 并收窄类型：只有 status='preview' 才返回 plan 视图，
 * no_inactive_objects 分支由专门用例断言。
 */
async function expectPreview(workflow: ObjectActivationWorkflow, input: PreviewObjectActivationInput = {}) {
  const result: ObjectActivationPreviewResult | { status: 'no_inactive_objects' } = await workflow.preview(input);
  if (result.status !== 'preview') throw new Error(`Expected a preview plan but got ${result.status}`);
  return result;
}

/**
 * 构造 inactiveObjects 的 mock 返回：
 * 两个可激活候选 + 一个 deleted 条目 + 一个纯 transport 条目（均应被跳过）。
 */
function inactiveRecords(): InactiveObjectRecord[] {
  return [
    {
      object: {
        'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_alpha',
        'adtcore:type': 'CLAS/OC',
        'adtcore:name': 'ZCL_ALPHA',
        'adtcore:parentUri': '/sap/bc/adt/packages/zpkg',
        user: 'DEVUSER',
        deleted: false
      }
    },
    {
      object: {
        'adtcore:uri': '/sap/bc/adt/programs/programs/zprog_beta',
        'adtcore:type': 'PROG/P',
        'adtcore:name': 'ZPROG_BETA',
        'adtcore:parentUri': '/sap/bc/adt/packages/zpkg',
        user: 'OTHERUSER',
        deleted: false
      }
    },
    {
      object: {
        'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_deleted',
        'adtcore:type': 'CLAS/OC',
        'adtcore:name': 'ZCL_DELETED',
        'adtcore:parentUri': '/sap/bc/adt/packages/zpkg',
        user: 'DEVUSER',
        deleted: true
      }
    },
    {
      transport: {
        'adtcore:uri': '/sap/bc/adt/transport',
        'adtcore:type': 'TRKORR',
        'adtcore:name': 'S4HK900009',
        'adtcore:parentUri': '/sap/bc/adt/transport',
        user: 'DEVUSER',
        deleted: false
      }
    }
  ];
}

/** ADT activate 的成功响应样例。 */
const activationSuccess = {
  success: true,
  messages: [
    { objDescr: 'ZCL_ALPHA', type: 'S', line: 0, href: '/sap/bc/adt/oo/classes/zcl_alpha', forceSupported: false, shortText: 'Object activated' }
  ],
  inactive: []
};

function setup(overrides: Record<string, unknown> = {}, ttlMs = 60_000) {
  // 可变时钟：过期测试通过推进 clock.now 模拟 TTL 超时
  const clock = { now: 1_000 };
  const policy = new SafetyPolicy({
    sapUrl: 'https://dev.example.test', sapClient: '100', sapUser: 'DEVUSER', systemRole: 'DEV',
    allowedHosts: 'dev.example.test', allowedClients: '100', allowedNamespaces: 'Z',
    auditPath: 'C:\\audit', toolProfile: 'development-workbench'
  });
  const client = {
    inactiveObjects: jest.fn().mockResolvedValue(inactiveRecords()),
    activate: jest.fn().mockResolvedValue(activationSuccess),
    ...overrides
  };
  const auditEvents: Record<string, unknown>[] = [];
  const audit = { append: jest.fn(async event => { auditEvents.push(event); }) };
  const store = new ObjectActivationPlanStore(ttlMs, () => clock.now, () => 'activation-1');
  const workflow = new ObjectActivationWorkflow(client as never, policy, store, audit);
  return { workflow, client, auditEvents, store, policy, clock };
}

describe('ObjectActivationWorkflow', () => {
  it('previews from inactive objects only, freezes a bounded plan, and never activates during preview', async () => {
    const test = setup();
    const result = await expectPreview(test.workflow);

    expect(result).toMatchObject({
      status: 'preview',
      confirmationRequired: true,
      plan: {
        activationPlanId: 'activation-1',
        status: 'PREVIEWED',
        systemHost: 'dev.example.test',
        client: '100',
        systemRole: 'DEV',
        toolProfile: 'development-workbench'
      }
    });
    // deleted 与 transport-only 条目被跳过，只保留两个可激活候选
    expect(result.plan.objects.map(object => object.objectName)).toEqual(['ZCL_ALPHA', 'ZPROG_BETA']);
    expect(result.plan.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    // TTL 冻结进 plan：expiresAt - createdAt = 60s
    expect(Date.parse(result.plan.expiresAt) - Date.parse(result.plan.createdAt)).toBe(60_000);
    // preview 是纯只读：activate 绝不被调用
    expect(test.client.activate).not.toHaveBeenCalled();
    expect(test.auditEvents.map(event => event.eventType)).toEqual(['OBJECT_ACTIVATION_PREVIEW_CREATED']);
  });

  it('applies a confirmed plan exactly once with the frozen ADT references', async () => {
    const test = setup();
    await test.workflow.preview({});

    const result = await test.workflow.apply('activation-1');

    // activate 收到的是 preview 冻结的精确 ADT 引用集合，不是调用方输入
    expect(test.client.activate).toHaveBeenCalledTimes(1);
    expect(test.client.activate).toHaveBeenCalledWith([
      {
        'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_alpha',
        'adtcore:type': 'CLAS/OC',
        'adtcore:name': 'ZCL_ALPHA',
        'adtcore:parentUri': '/sap/bc/adt/packages/zpkg'
      },
      {
        'adtcore:uri': '/sap/bc/adt/programs/programs/zprog_beta',
        'adtcore:type': 'PROG/P',
        'adtcore:name': 'ZPROG_BETA',
        'adtcore:parentUri': '/sap/bc/adt/packages/zpkg'
      }
    ], true);
    expect(result).toMatchObject({
      status: 'success',
      plan: {
        status: 'SUCCEEDED',
        result: { kind: 'OBJECT_ACTIVATION', success: true, messageCount: 1, remainingInactiveCount: 0 }
      }
    });
    expect(test.auditEvents.map(event => event.eventType)).toEqual([
      'OBJECT_ACTIVATION_PREVIEW_CREATED', 'OBJECT_ACTIVATION_CONFIRMED', 'OBJECT_ACTIVATION_COMPLETED'
    ]);
    // 单次语义：成功后的 plan 拒绝再次 apply
    await expect(test.workflow.apply('activation-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(test.client.activate).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit objectNames filter when freezing the plan', async () => {
    const test = setup();
    const result = await expectPreview(test.workflow, { objectNames: ['zcl_alpha'] });

    expect(result.plan.objects.map(object => object.objectName)).toEqual(['ZCL_ALPHA']);
    await test.workflow.apply('activation-1');
    expect(test.client.activate).toHaveBeenCalledWith([expect.objectContaining({
      'adtcore:name': 'ZCL_ALPHA'
    })], true);
  });

  it('returns no_inactive_objects without creating a plan when nothing is inactive', async () => {
    const test = setup({ inactiveObjects: jest.fn().mockResolvedValue([]) });
    const result = await test.workflow.preview({});

    expect(result).toMatchObject({ status: 'no_inactive_objects', confirmationRequired: false });
    // 没有创建任何 plan：查询未知 plan 应报 PLAN_NOT_FOUND
    await expect(test.workflow.apply('activation-1')).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    expect(test.client.activate).not.toHaveBeenCalled();
  });

  it('rejects oversized candidate sets and unknown preview fields', async () => {
    // 51 个未激活对象超过单 plan 上限，必须显式过滤
    const flooded = Array.from({ length: 51 }, (_, index) => ({
      object: {
        'adtcore:uri': `/sap/bc/adt/oo/classes/zcl_bulk_${index}`,
        'adtcore:type': 'CLAS/OC',
        'adtcore:name': `ZCL_BULK_${index}`,
        'adtcore:parentUri': '/sap/bc/adt/packages/zpkg',
        user: 'DEVUSER',
        deleted: false
      }
    }));
    const flood = setup({ inactiveObjects: jest.fn().mockResolvedValue(flooded) });
    await expect(flood.workflow.preview({})).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const strict = setup();
    await expect(strict.workflow.preview({ forgedUri: '/sap/bc/adt/oo/classes/zcl_x' } as never))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(strict.client.activate).not.toHaveBeenCalled();
  });

  it('rejects unknown and expired plans before any activation', async () => {
    const expired = setup({}, 60_000);
    await expired.workflow.preview({});
    // 推进时钟越过 TTL：plan 惰性过期
    expired.clock.now = 61_000;
    await expect(expired.workflow.apply('activation-1')).rejects.toMatchObject({ code: 'PLAN_EXPIRED' });
    expect(expired.client.activate).not.toHaveBeenCalled();

    const unknown = setup();
    await expect(unknown.workflow.apply('missing-plan')).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it('marks an activation exception UNKNOWN_OUTCOME and never retries', async () => {
    const test = setup({ activate: jest.fn().mockRejectedValue(new Error('connection reset')) });
    await test.workflow.preview({});

    await expect(test.workflow.apply('activation-1')).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
      details: { plan: { status: 'UNKNOWN_OUTCOME' } }
    });
    // 结果未知即停止：绝不能对同一 plan 再次执行
    await expect(test.workflow.apply('activation-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(test.client.activate).toHaveBeenCalledTimes(1);
    expect(test.workflow.status('activation-1')).toMatchObject({
      status: 'UNKNOWN_OUTCOME',
      primaryError: { code: 'UNKNOWN_OUTCOME', stage: 'EXECUTE' }
    });
    expect(test.auditEvents.map(event => event.eventType)).toContain('OBJECT_ACTIVATION_UNKNOWN');
  });

  it('treats an ADT failure result as UNKNOWN_OUTCOME because partial activation cannot be ruled out', async () => {
    const test = setup({
      activate: jest.fn().mockResolvedValue({ success: false, messages: [], inactive: [] })
    });
    await test.workflow.preview({});

    await expect(test.workflow.apply('activation-1')).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
      details: { plan: { status: 'UNKNOWN_OUTCOME' } }
    });
    expect(test.client.activate).toHaveBeenCalledTimes(1);
  });

  it('keeps the execution payload out of every view and enforces the preview context', async () => {
    const test = setup();
    await test.workflow.preview({});
    const serialized = JSON.stringify(test.workflow.status('activation-1'));
    // 对外视图绝不包含执行载荷：既没有 ADT 原生引用键（adtcore:uri），
    // 也没有 preaudit 开关等 apply 专用字段
    expect(serialized).not.toContain('adtcore:uri');
    expect(serialized).not.toContain('preauditRequested');

    // 上下文绑定：不同 toolProfile 的会话不能读取或执行该 plan
    const foreignPolicy = new SafetyPolicy({
      sapUrl: 'https://dev.example.test', sapClient: '100', sapUser: 'DEVUSER', systemRole: 'DEV',
      allowedHosts: 'dev.example.test', allowedClients: '100', allowedNamespaces: 'Z',
      auditPath: 'C:\\audit', toolProfile: 'development'
    });
    const foreignWorkflow = new ObjectActivationWorkflow(
      test.client as never, foreignPolicy, test.store, { append: jest.fn() }
    );
    expect(() => foreignWorkflow.status('activation-1')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
    await expect(foreignWorkflow.apply('activation-1')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(test.client.activate).not.toHaveBeenCalled();
  });
});
