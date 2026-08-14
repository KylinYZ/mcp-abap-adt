import { DebugControlWorkflow } from '../safe/DebugControlWorkflow';
import { DebugOperationPlanStore } from '../safe/DebugOperationPlanStore';
import { DebugSessionAuthorizationStore } from '../safe/DebugSessionAuthorizationStore';
import { SafetyPolicy } from '../safe/SafetyPolicy';

describe('DebugControlWorkflow', () => {
  function setup(overrides: Record<string, jest.Mock> = {}) {
    let nextId = 1;
    const stack = {
      isRfc: false,
      isSameSystem: true,
      serverName: 'server-1',
      debugCursorStackIndex: 0,
      stack: [{
        programName: 'ZTEST',
        includeName: 'ZTEST',
        line: 10,
        eventType: 'REPORT',
        eventName: 'START-OF-SELECTION',
        stackPosition: 0,
        systemProgram: false,
        uri: {}
      }]
    };
    const variable = {
      ID: 'LV_VALUE',
      NAME: 'LV_VALUE',
      VALUE: 'OLD',
      READ_ONLY: '',
      DECLARED_TYPE_NAME: 'STRING',
      ACTUAL_TYPE_NAME: 'STRING',
      KIND: '',
      INSTANTIATION_KIND: '',
      ACCESS_KIND: '',
      META_TYPE: 'string',
      PARAMETER_KIND: '',
      HEX_VALUE: '',
      TECHNICAL_TYPE: '',
      LENGTH: 3,
      TABLE_BODY: '',
      TABLE_LINES: 0,
      IS_VALUE_INCOMPLETE: '',
      IS_EXCEPTION: '',
      INHERITANCE_LEVEL: 0,
      INHERITANCE_CLASS: ''
    };
    const attach = {
      debugSessionId: 'debug-session-1',
      debuggeeSessionId: 'debuggee-session-1',
      serverName: 'server-1',
      processId: 123,
      isDebuggeeChanged: false
    };
    const client = {
      debuggerListeners: jest.fn().mockResolvedValue(undefined),
      debuggerListen: jest.fn().mockResolvedValue(undefined),
      debuggerDeleteListener: jest.fn().mockResolvedValue(undefined),
      debuggerSetBreakpoints: jest.fn().mockResolvedValue([]),
      debuggerDeleteBreakpoints: jest.fn().mockResolvedValue(undefined),
      debuggerAttach: jest.fn().mockResolvedValue(attach),
      debuggerSaveSettings: jest.fn().mockResolvedValue({}),
      debuggerStackTrace: jest.fn().mockResolvedValue(stack),
      debuggerVariables: jest.fn().mockResolvedValue([variable]),
      debuggerChildVariables: jest.fn().mockResolvedValue({ hierarchies: [], variables: [] }),
      debuggerStep: jest.fn().mockResolvedValue({ ...attach, isDebuggeeChanged: false, settings: {} }),
      debuggerGoToStack: jest.fn().mockResolvedValue(undefined),
      debuggerSetVariableValue: jest.fn().mockResolvedValue('OK'),
      ...overrides
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
    return { workflow, client, audit, stack, variable };
  }

  async function attachAndAuthorize(workflow: DebugControlWorkflow, debuggeeId = 'debuggee-1') {
    const preview = await workflow.previewOperation({
      operation: { kind: 'ATTACH', debuggingMode: 'user', debuggeeId, targetUser: 'DEVUSER' }
    });
    const plan = preview.plan as { debugOperationPlanId: string };
    await workflow.applyOperation({ debugOperationPlanId: plan.debugOperationPlanId, confirmedByUser: true });
    const authorized = await workflow.authorizeConfirmed('DEVUSER', debuggeeId);
    return (authorized.authorization as { authorizationId: string }).authorizationId;
  }

  it('maps a confirmed listener plan to one low-level call', async () => {
    const { workflow, client } = setup();
    const preview = await workflow.previewOperation({
      operation: {
        kind: 'CREATE_LISTENER',
        debuggingMode: 'user',
        terminalId: 'terminal-1',
        ideId: 'ide-1',
        targetUser: 'devuser',
        checkConflict: true
      }
    });
    const plan = preview.plan as { debugOperationPlanId: string };
    await expect(workflow.applyOperation({ debugOperationPlanId: plan.debugOperationPlanId, confirmedByUser: true }))
      .resolves.toMatchObject({ status: 'success' });
    expect(client.debuggerListen).toHaveBeenCalledTimes(1);
    expect(client.debuggerListen).toHaveBeenCalledWith('user', 'terminal-1', 'ide-1', 'DEVUSER', true, undefined);
  });

  it('executes one authorized command and rereads the stack', async () => {
    const { workflow, client } = setup();
    const authorizationId = await attachAndAuthorize(workflow);
    client.debuggerStackTrace.mockClear();

    await expect(workflow.executeCommand({
      authorizationId,
      targetUser: 'DEVUSER',
      command: { command: 'stepInto' }
    })).resolves.toMatchObject({ status: 'success', authorizationRevoked: false });
    expect(client.debuggerStep).toHaveBeenCalledTimes(1);
    expect(client.debuggerStep).toHaveBeenCalledWith('stepInto');
    expect(client.debuggerStackTrace).toHaveBeenCalledTimes(1);
  });

  it('keeps jump and terminate out of the ordinary command path', async () => {
    const { workflow, client } = setup();
    const authorizationId = await attachAndAuthorize(workflow);
    await expect(workflow.executeCommand({
      authorizationId,
      targetUser: 'DEVUSER',
      command: { command: 'stepJumpToLine', url: '/source#42' } as never
    })).rejects.toThrow('separate preview');
    expect(client.debuggerStep).not.toHaveBeenCalled();
  });

  it('executes a separately previewed jump and rereads the stack', async () => {
    const { workflow, client } = setup();
    const authorizationId = await attachAndAuthorize(workflow);
    const preview = await workflow.previewOperation({
      operation: {
        kind: 'JUMP_TO_LINE',
        targetUser: 'DEVUSER',
        authorizationId,
        debuggeeId: 'debuggee-1',
        url: '/source#42'
      }
    });
    const plan = preview.plan as { debugOperationPlanId: string };
    await workflow.applyOperation({ debugOperationPlanId: plan.debugOperationPlanId, confirmedByUser: true });
    expect(client.debuggerStep).toHaveBeenCalledWith('stepJumpToLine', '/source#42');
    expect(client.debuggerStackTrace).toHaveBeenCalled();
  });

  it('rejects variable drift before changing runtime state', async () => {
    const changedVariable = { ...setup().variable, VALUE: 'CHANGED' };
    const variables = jest.fn()
      .mockResolvedValueOnce([setup().variable])
      .mockResolvedValueOnce([changedVariable]);
    const { workflow, client } = setup({ debuggerVariables: variables });
    const authorizationId = await attachAndAuthorize(workflow);
    const preview = await workflow.previewVariableChange({
      authorizationId,
      targetUser: 'DEVUSER',
      variableName: 'LV_VALUE',
      newValue: 'NEW'
    });
    const plan = preview.plan as { debugOperationPlanId: string };

    await expect(workflow.applyOperation({ debugOperationPlanId: plan.debugOperationPlanId, confirmedByUser: true }))
      .rejects.toThrow('changed after preview');
    expect(client.debuggerSetVariableValue).not.toHaveBeenCalled();
  });

  it('does not retry an uncertain remote operation and only reads recovery state', async () => {
    const listen = jest.fn().mockRejectedValue(new Error('request timeout'));
    const { workflow, client } = setup({ debuggerListen: listen });
    const preview = await workflow.previewOperation({
      operation: {
        kind: 'CREATE_LISTENER',
        debuggingMode: 'user',
        terminalId: 'terminal-1',
        ideId: 'ide-1',
        targetUser: 'DEVUSER'
      }
    });
    const plan = preview.plan as { debugOperationPlanId: string };
    await expect(workflow.applyOperation({ debugOperationPlanId: plan.debugOperationPlanId, confirmedByUser: true }))
      .resolves.toMatchObject({ status: 'remote_result_unknown', retryPerformed: false });
    expect(listen).toHaveBeenCalledTimes(1);
    expect(client.debuggerListeners).toHaveBeenCalledTimes(1);
  });

  it('invalidates an old authorization after a new Attach succeeds', async () => {
    const { workflow } = setup();
    const authorizationId = await attachAndAuthorize(workflow, 'debuggee-1');
    const preview = await workflow.previewOperation({
      operation: { kind: 'ATTACH', debuggingMode: 'user', debuggeeId: 'debuggee-2', targetUser: 'DEVUSER' }
    });
    const plan = preview.plan as { debugOperationPlanId: string };
    await workflow.applyOperation({ debugOperationPlanId: plan.debugOperationPlanId, confirmedByUser: true });

    await expect(workflow.executeCommand({
      authorizationId,
      targetUser: 'DEVUSER',
      command: { command: 'stepContinue' }
    })).rejects.toThrow();
  });

  it('rejects QAS before any ADT debug control call', async () => {
    const { workflow, client } = setup();
    (workflow as unknown as { policy: SafetyPolicy }).policy = new SafetyPolicy({
      sapUrl: 'https://dev.example.com',
      sapClient: '100',
      sapUser: 'DEVUSER',
      systemRole: 'QAS',
      allowedHosts: 'dev.example.com',
      allowedClients: '100',
      allowedNamespaces: 'Z',
      auditPath: 'C:\\audit',
      toolProfile: 'development'
    });
    await expect(workflow.previewOperation({
      operation: { kind: 'ATTACH', debuggingMode: 'user', debuggeeId: 'debuggee-1', targetUser: 'DEVUSER' }
    })).rejects.toThrow('SYSTEM_ROLE=DEV');
    expect(client.debuggerAttach).not.toHaveBeenCalled();
  });
});
