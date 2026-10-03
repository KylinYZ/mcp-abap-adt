/**
 * DebugControlWorkflow AMDP 四操作受控链单测（矩阵行 debug.amdp-adt）。
 *
 * 覆盖：preview→apply 状态机、AMDP 会话登记状态机（未 start 拒止 /
 * TERMINATE 注销后不可复用）、AWAIT 的"未等到=成功观察"语义、输入校验
 * （maxEvents 边界、断点形状、syncMode 枚举）。协议层陷阱由
 * src/adt/api/__tests__/amdpDebugger.test.ts 覆盖。
 */
import { DebugControlWorkflow } from '../safe/DebugControlWorkflow';
import { DebugOperationPlanStore } from '../safe/DebugOperationPlanStore';
import { DebugSessionAuthorizationStore } from '../safe/DebugSessionAuthorizationStore';
import { SafetyPolicy } from '../safe/SafetyPolicy';

describe('DebugControlWorkflow AMDP 四操作', () => {
  /** 同构现有 DebugControlWorkflow.test.ts 的 setup：fake client + DEV 策略 + 计划/授权存储。 */
  function setup(amdpOverrides: Record<string, jest.Mock> = {}) {
    let nextId = 1;
    const client = {
      debuggerListeners: jest.fn().mockResolvedValue(undefined),
      debuggerListen: jest.fn().mockResolvedValue(undefined),
      debuggerDeleteListener: jest.fn().mockResolvedValue(undefined),
      debuggerSetBreakpoints: jest.fn().mockResolvedValue([]),
      debuggerDeleteBreakpoints: jest.fn().mockResolvedValue(undefined),
      debuggerAttach: jest.fn().mockResolvedValue({
        debugSessionId: 'debug-session-1',
        debuggeeSessionId: 'debuggee-session-1',
        serverName: 'server-1',
        processId: 123,
        isDebuggeeChanged: false
      }),
      debuggerSaveSettings: jest.fn().mockResolvedValue({}),
      debuggerStackTrace: jest.fn().mockResolvedValue({ isRfc: false, isSameSystem: true, serverName: 's', debugCursorStackIndex: 0, stack: [] }),
      debuggerVariables: jest.fn().mockResolvedValue([]),
      debuggerChildVariables: jest.fn().mockResolvedValue({ hierarchies: [], variables: [] }),
      debuggerStep: jest.fn().mockResolvedValue({}),
      debuggerGoToStack: jest.fn().mockResolvedValue(undefined),
      debuggerSetVariableValue: jest.fn().mockResolvedValue('OK'),
      // AMDP 协议层委托（默认 happy path；用例按需 mockReset/覆写）
      amdpDebuggerStart: jest.fn().mockResolvedValue({ mainId: 'SESS-1', hanaSessionId: 'hdb:30015:402155' }),
      amdpDebuggerSyncBreakpoints: jest.fn().mockResolvedValue(undefined),
      amdpDebuggerAwaitStop: jest.fn().mockResolvedValue({
        stopped: true, events: [], variables: [], callStack: [],
        stop: { debuggeeId: 'dg-1', procedure: 'ZCL_X=>GET', uri: '/sap/bc/adt/oo/classes/zcl_x/source/main#start=41', line: 41 }
      }),
      amdpDebuggerTerminate: jest.fn().mockResolvedValue(undefined),
      ...amdpOverrides
    };
    const policy = new SafetyPolicy({
      sapUrl: 'https://dev.example.com:44300',
      sapClient: '100',
      sapUser: 'DEVUSER',
      systemRole: 'DEV',
      allowedHosts: 'dev.example.com',
      allowedClients: '100',
      allowedNamespaces: 'Z',
      auditPath: 'C:\\audit',
      toolProfile: 'development'
    });
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const workflow = new DebugControlWorkflow(
      client as never,
      policy,
      new DebugOperationPlanStore(900_000, () => 1_000, () => `plan-${nextId++}`),
      new DebugSessionAuthorizationStore(900_000, () => 1_000, () => `auth-${nextId++}`),
      audit
    );
    return { workflow, client, audit };
  }

  /** preview→apply 快捷通道：返回 apply 的完整结果。 */
  async function previewAndApply(
    workflow: DebugControlWorkflow,
    operation: Record<string, unknown>
  ) {
    const preview = await workflow.previewOperation({ operation });
    const plan = preview.plan as { debugOperationPlanId: string; status: string; summary: string; risk: string };
    expect(plan.status).toBe('PREVIEWED');
    const applied = await workflow.applyOperation({
      debugOperationPlanId: plan.debugOperationPlanId,
      confirmedByUser: true
    });
    return { applied, plan };
  }

  it('AMDP_START：启动并登记会话，apply 返回 mainId/HANA 会话', async () => {
    const { workflow, client } = setup();
    const { applied } = await previewAndApply(workflow, {
      kind: 'AMDP_START', targetUser: 'devuser', stopExisting: true
    });
    expect(applied).toMatchObject({ status: 'success' });
    expect(client.amdpDebuggerStart).toHaveBeenCalledWith({ user: 'DEVUSER', stopExisting: true });
    expect((applied.result as { mainId: string }).mainId).toBe('SESS-1');
  });

  it('AMDP_SYNC_BREAKPOINTS 未 start 即拒止（AMDP_SESSION_REQUIRED，plan FAILED）', async () => {
    const { workflow, client, audit } = setup();
    const preview = await workflow.previewOperation({
      operation: { kind: 'AMDP_SYNC_BREAKPOINTS', targetUser: 'DEVUSER', breakpoints: [{ class: 'ZCL_X', line: 41 }] }
    });
    const plan = preview.plan as { debugOperationPlanId: string };
    await expect(workflow.applyOperation({ debugOperationPlanId: plan.debugOperationPlanId, confirmedByUser: true }))
      .rejects.toMatchObject({ code: 'AMDP_SESSION_REQUIRED' });
    // 拒止发生在协议层调用之前：不向 SAP 发出任何断点请求
    expect(client.amdpDebuggerSyncBreakpoints).not.toHaveBeenCalled();
    const status = workflow.status(plan.debugOperationPlanId);
    expect(status.status).toBe('FAILED');
    expect(status.primaryError?.code).toBe('AMDP_SESSION_REQUIRED');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'DEBUG_OPERATION_FAILED', success: false }));
  });

  it('start→sync→await→terminate 全链：mainId 内部流转，terminate 注销后不可复用', async () => {
    const { workflow, client } = setup();
    await previewAndApply(workflow, { kind: 'AMDP_START', targetUser: 'DEVUSER' });

    const sync = await previewAndApply(workflow, {
      kind: 'AMDP_SYNC_BREAKPOINTS', targetUser: 'DEVUSER',
      breakpoints: [{ class: 'zcl_amdp_smoke', line: 41 }], syncMode: 'FULL'
    });
    expect(client.amdpDebuggerSyncBreakpoints).toHaveBeenCalledWith(
      'SESS-1', [{ class: 'zcl_amdp_smoke', line: 41 }], 'FULL'
    );
    expect(sync.applied.result).toMatchObject({ synced: 1, syncMode: 'FULL' });

    const awaitResult = await previewAndApply(workflow, { kind: 'AMDP_AWAIT_STOP', targetUser: 'DEVUSER', maxEvents: 5 });
    expect(client.amdpDebuggerAwaitStop).toHaveBeenCalledWith('SESS-1', 5);
    expect((awaitResult.applied.result as { stopped: boolean }).stopped).toBe(true);

    await previewAndApply(workflow, { kind: 'AMDP_TERMINATE', targetUser: 'DEVUSER' });
    expect(client.amdpDebuggerTerminate).toHaveBeenCalledWith('SESS-1', undefined);

    // 注销后 TERMINATE 不可重放：句柄已清，拒绝即不向 SAP 发请求
    const stale = await workflow.previewOperation({ operation: { kind: 'AMDP_TERMINATE', targetUser: 'DEVUSER' } });
    const stalePlan = stale.plan as { debugOperationPlanId: string };
    await expect(workflow.applyOperation({ debugOperationPlanId: stalePlan.debugOperationPlanId, confirmedByUser: true }))
      .rejects.toMatchObject({ code: 'AMDP_SESSION_REQUIRED' });
    expect(client.amdpDebuggerTerminate).toHaveBeenCalledTimes(1);
  });

  it('AWAIT 未等到是成功观察（stopped=false，plan APPLIED 可再轮询）', async () => {
    const { workflow } = setup({
      amdpDebuggerAwaitStop: jest.fn().mockResolvedValue({
        stopped: false, events: [], variables: [], callStack: [],
        breakpointVerdict: { state: 'VALID' },
        note: 'nothing stopped within 12 answers; the debuggee may not have run'
      })
    });
    await previewAndApply(workflow, { kind: 'AMDP_START', targetUser: 'DEVUSER' });
    const { applied, plan } = await previewAndApply(workflow, { kind: 'AMDP_AWAIT_STOP', targetUser: 'DEVUSER' });
    expect(applied.status).toBe('success');
    expect((applied.result as { stopped: boolean }).stopped).toBe(false);
    expect(workflow.status((applied.plan as { debugOperationPlanId: string }).debugOperationPlanId).status).toBe('APPLIED');
    void plan;
  });

  it('preview 输入校验：maxEvents 越界 / 断点空集 / 非法 syncMode', async () => {
    const { workflow } = setup();
    await expect(workflow.previewOperation({
      operation: { kind: 'AMDP_AWAIT_STOP', targetUser: 'DEVUSER', maxEvents: 51 }
    })).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
    await expect(workflow.previewOperation({
      operation: { kind: 'AMDP_SYNC_BREAKPOINTS', targetUser: 'DEVUSER', breakpoints: [] }
    })).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
    await expect(workflow.previewOperation({
      operation: { kind: 'AMDP_SYNC_BREAKPOINTS', targetUser: 'DEVUSER', breakpoints: [{ class: 'A', line: 1 }], syncMode: 'PARTIAL' }
    })).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
    await expect(workflow.previewOperation({
      operation: { kind: 'AMDP_SYNC_BREAKPOINTS', targetUser: 'DEVUSER', breakpoints: [{ class: 'A', line: 0 }] }
    })).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });

  it('preview 描述携带 AMDP 语义（summary/risk），策略沿用 DEV + development 门槛', async () => {
    const { workflow } = setup();
    const preview = await workflow.previewOperation({
      operation: { kind: 'AMDP_START', targetUser: 'DEVUSER' }
    });
    const plan = preview.plan as { summary: string; risk: string };
    expect(plan.summary).toMatch(/AMDP \(HANA\) debug session/);
    expect(plan.risk).toMatch(/ABAP↔HANA debug bridge/);
  });

  it('非 development profile 拒止 AMDP 操作（与既有调试面同门槛）', async () => {
    // development-workbench 同样允许（assertDebugControlAllowed 的 profile 白名单）
    const { workflow: workbenchWorkflow } = setup();
    await expect(workbenchWorkflow.previewOperation({
      operation: { kind: 'AMDP_START', targetUser: 'DEVUSER' }
    })).resolves.toMatchObject({ status: 'preview' });

    // 只读 profile 在策略门即拒绝：AMDP 调试只进 development/development-workbench
    const readonlyPolicy = new SafetyPolicy({
      sapUrl: 'https://dev.example.com:44300',
      sapClient: '100',
      sapUser: 'DEVUSER',
      systemRole: 'DEV',
      allowedHosts: 'dev.example.com',
      allowedClients: '100',
      allowedNamespaces: 'Z',
      auditPath: 'C:\\audit',
      toolProfile: 'diagnostic-readonly'
    });
    const readonlyWorkflow = new DebugControlWorkflow(
      { amdpDebuggerStart: jest.fn() } as never,
      readonlyPolicy,
      new DebugOperationPlanStore(900_000, () => 1_000, () => 'plan-ro'),
      new DebugSessionAuthorizationStore(900_000, () => 1_000, () => 'auth-ro'),
      { append: jest.fn().mockResolvedValue(undefined) }
    );
    await expect(readonlyWorkflow.previewOperation({
      operation: { kind: 'AMDP_START', targetUser: 'DEVUSER' }
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
