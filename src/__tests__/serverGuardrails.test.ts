import { RuntimeGuardrails } from '../config/RuntimeGuardrails';
import { SafeAbapHandlers } from '../handlers/SafeAbapHandlers';
import { ToolExecutionGate } from '../lib/ToolExecutionGate';
import { adtClientOptions, executeGuardedToolCall, usesSapExecutionGate } from '../lib/serverGuardrails';
import type { AbapChangeWorkflow, ApplyChangeInput } from '../safe/AbapChangeWorkflow';
import { SafeAbapError } from '../safe/errors';
import type { ChangePlanView } from '../safe/types';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

const guardrails = RuntimeGuardrails.fromEnvironment({});
const errorResult = (error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (normalized instanceof SafeAbapError) {
    return { content: [{ type: 'text', text: JSON.stringify(normalized.toResponse()) }], isError: true };
  }
  if (normalized instanceof McpError) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: normalized.message, code: normalized.code }) }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ error: 'Internal server error', code: -32603 }) }], isError: true };
};

describe('server guardrail integration helpers', () => {
  it('passes the parsed timeout to ADT client options', () => {
    expect(adtClientOptions({ ...guardrails, adtTimeoutMs: 12_345 })).toEqual({ timeout: 12_345 });
  });

  it('applies argument limits before dispatch', async () => {
    const dispatch = jest.fn(async () => ({ content: [] }));
    await executeGuardedToolCall('runQuery', { sqlQuery: 'SELECT *' }, guardrails, new ToolExecutionGate(1, 1), true, dispatch, value => value, errorResult);
    expect(dispatch).toHaveBeenCalledWith({ sqlQuery: 'SELECT *', rowNumber: 200 });
  });

  it('uses one gate for safe and legacy calls', async () => {
    const gate = new ToolExecutionGate(1, 2);
    const order: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const first = executeGuardedToolCall('inspectAbapObject', {}, guardrails, gate, true, async () => {
      order.push('safe-start'); await blocker; order.push('safe-end'); return { content: [] };
    }, value => value, errorResult);
    const second = executeGuardedToolCall('searchObject', {}, guardrails, gate, true, async () => {
      order.push('legacy'); return { content: [] };
    }, value => value, errorResult);
    await Promise.resolve();
    expect(order).toEqual(['safe-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['safe-start', 'safe-end', 'legacy']);
  });

  it('rejects oversized serialized responses', async () => {
    await expect(executeGuardedToolCall(
      'healthcheck', {}, { ...guardrails, maxResponseBytes: 3 }, new ToolExecutionGate(1, 1),
      false,
      async () => 'large', value => ({ content: [{ type: 'text', text: String(value) }] }), errorResult
    )).resolves.toMatchObject({ isError: true });
  });

  it('keeps confirmation waiting outside the SAP gate and gates confirmed apply atomically', async () => {
    const gate = new ToolExecutionGate(1, 2);
    const plan: ChangePlanView = {
      changePlanId: 'plan-1',
      createdAt: '2026-08-12T00:00:00.000Z',
      expiresAt: '2099-08-12T00:15:00.000Z',
      status: 'PREVIEWED',
      systemHost: 'dev.example.com',
      client: '100',
      object: {
        objectType: 'PROGRAM',
        objectName: 'ZTEST',
        adtType: 'PROG/P',
        objectUrl: '/object',
        sourceUrl: '/source',
        lockUrl: '/object',
        activationName: 'ZTEST',
        activationUrl: '/object'
      },
      transportRequest: 'DEVK900001',
      originalHash: 'original',
      targetHash: 'target',
      diffSummary: { addedLines: 1, removedLines: 0, unchangedPrefixLines: 1, unchangedSuffixLines: 0 },
      syntaxMessages: [],
      stages: []
    };
    let acceptConfirmation!: () => void;
    const confirmation = new Promise<void>(resolve => { acceptConfirmation = resolve; });
    let releaseApply!: () => void;
    const applyBlocker = new Promise<void>(resolve => { releaseApply = resolve; });
    const order: string[] = [];
    const workflow = {
      status: jest.fn().mockReturnValue(plan),
      apply: jest.fn(async (_input: ApplyChangeInput) => {
        order.push('apply-start');
        await applyBlocker;
        order.push('apply-end');
        return { status: 'success' };
      })
    };
    const handlers = new SafeAbapHandlers(workflow as unknown as AbapChangeWorkflow, {
      allowTextConfirmation: false,
      supportsFormElicitation: () => true,
      elicitInput: async () => {
        await confirmation;
        return { action: 'accept', content: { decision: 'apply' } };
      },
      applyConfirmed: input => gate.run(() => workflow.apply(input))
    });
    const execute = (toolName: string, argumentsValue: Record<string, unknown>, dispatch: (args: Record<string, unknown>) => Promise<unknown>) =>
      executeGuardedToolCall(
        toolName,
        argumentsValue,
        guardrails,
        gate,
        usesSapExecutionGate(toolName),
        dispatch,
        value => value,
        errorResult
      );

    const apply = execute('applyAbapChange', { changePlanId: 'plan-1' }, args => handlers.handle('applyAbapChange', args));
    await Promise.resolve();
    await expect(execute('healthcheck', {}, async () => ({ status: 'healthy' }))).resolves.toEqual({ status: 'healthy' });
    await expect(execute('getAbapChangeStatus', { changePlanId: 'plan-1' }, args => handlers.handle('getAbapChangeStatus', args)))
      .resolves.toMatchObject({ status: 'success' });
    expect(order).toEqual([]);

    acceptConfirmation();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['apply-start']);
    const legacy = execute('searchObject', {}, async () => {
      order.push('legacy');
      return { content: [] };
    });
    await Promise.resolve();
    expect(order).toEqual(['apply-start']);

    releaseApply();
    await Promise.all([apply, legacy]);
    expect(order).toEqual(['apply-start', 'apply-end', 'legacy']);
  });

  it.each([
    ['applyAbapChange', false],
    ['getAbapChangeStatus', false],
    ['healthcheck', false],
    ['inspectAbapObject', true],
    ['previewAbapChange', true],
    ['searchObject', true]
  ] as const)('classifies %s SAP gate usage as %s', (toolName, expected) => {
    expect(usesSapExecutionGate(toolName)).toBe(expected);
  });

  it('replaces an oversized error response with a fixed small 413 without leaking original content', async () => {
    const secret = 'sensitive-error-content-'.repeat(100);

    const result = await executeGuardedToolCall(
      'getAbapChangeStatus',
      {},
      { ...guardrails, maxResponseBytes: 200 },
      new ToolExecutionGate(1, 1),
      false,
      async () => {
        throw new SafeAbapError('VERIFY_FAILED', 'verify', secret, { payload: secret });
      },
      value => value,
      errorResult
    );

    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({ isError: true });
    expect(serialized).toContain('413');
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(200);
    expect(serialized).not.toContain('sensitive-error-content');
  });

  it('preserves the existing contract for a small error response', async () => {
    const result = await executeGuardedToolCall(
      'getAbapChangeStatus',
      {},
      guardrails,
      new ToolExecutionGate(1, 1),
      false,
      async () => { throw new McpError(400, 'small validation error'); },
      value => value,
      errorResult
    );

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ error: 'MCP error 400: small validation error', code: 400 }) }],
      isError: true
    });
  });
});
