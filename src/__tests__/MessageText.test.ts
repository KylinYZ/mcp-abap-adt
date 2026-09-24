/**
 * 受控消息文本写入三件套测试：ADT 协议（XML 构造/解析）、工作流（plan/同值短路/
 * 锁链/readback）、handler 工具面。HTTP 与锁全部 mock，不连接 SAP。
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  buildMessageClassXml, parseMessageClassTexts, messageClassURL
} from '../adt/MessageClassApi';
import { MessageTextWorkflow, normalizeMessageTexts } from '../safe/MessageTextWorkflow';
import { MessageTextHandlers } from '../handlers/MessageTextHandlers';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

const XML = '<?xml version="1.0"?><messageClass><messages msgno="001" msgtext="Hello"/><messages msgno="002" msgtext="World"/></messageClass>';
const policy = {
  systemHost: 'dev.test', client: '300', sapUser: 'DEVUSER', systemRole: 'DEV',
  toolProfile: 'development-workbench', planTtlMs: 15 * 60 * 1000
};
const audit = { append: jest.fn().mockResolvedValue(undefined) };

describe('MessageClassApi protocol', () => {
  it('parses messageclass XML entries', () => {
    expect(parseMessageClassTexts(XML)).toEqual([
      { number: '001', text: 'Hello' }, { number: '002', text: 'World' }
    ]);
    // namespaced 属性 + 单消息折叠形态（fast-xml-parser 单子元素折叠为对象）
    expect(parseMessageClassTexts(
      '<?xml version="1.0"?><mc:messageClass><mc:messages mc:msgno="001" mc:msgtext="Solo"/></mc:messageClass>'
    )).toEqual([{ number: '001', text: 'Solo' }]);
  });

  it('builds rich message rows with escaped attributes', () => {
    const xml = buildMessageClassXml('ZMC_TEST', [{ number: '001', text: 'A & B <C>' }]);
    expect(xml).toContain('<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass"');
    // 行形态对齐真机已验证的受控创建链：富属性 + atom:link 子元素，行内不带锁句柄
    expect(xml).toContain('<mc:messages mc:msgno="001" mc:msgtext="A &amp; B &lt;C&gt;" mc:selfexplainatory="false"');
    expect(xml).toContain('rel="http://www.sap.com/adt/relations/messageclasses/messages"');
  });

  it('builds the lowercase messageclass URL', () => {
    expect(messageClassURL('ZMC_TEST')).toBe('/sap/bc/adt/messageclass/zmc_test');
  });

  it('normalizes texts input', () => {
    expect(normalizeMessageTexts([{ number: '001', text: ' Hi ' }])).toEqual([{ number: '001', text: 'Hi' }]);
    expect(() => normalizeMessageTexts([{ number: '1', text: 'x' }])).toThrow(/3-digit/);
    expect(() => normalizeMessageTexts([])).toThrow(/non-empty/);
  });
});

describe('MessageTextWorkflow', () => {
  // 模拟服务端状态：PUT 后 mc:messages 更新，后续 GET 返回新数据（模拟 stateful SAP 行为）
  let serverMessages: Array<{ msgno: string; msgtext: string }> = [];
  const http = {
    request: jest.fn(async (url: string, init: { method: string; body?: string }) => {
      if (init?.method === 'PUT') {
        // 从 PUT body 解析 mc:messages 并存入服务端状态
        const matches = [...(init.body ?? '').matchAll(/mc:msgno="([^"]*)"\s+mc:msgtext="([^"]*)"/g)];
        serverMessages = matches.map(m => ({ msgno: m[1], msgtext: m[2] }));
      }
      const messagesXml = serverMessages.map(m => `<mc:messages mc:msgno="${m.msgno}" mc:msgtext="${m.msgtext}"/>`).join('');
      return { status: 200, body: `<?xml?><mc:messageClass>${messagesXml}</mc:messageClass>`, headers: {} };
    })
  };
  const lockCalls: Array<[string, string]> = [];
  const unlockCalls: string[] = [];
  const locks = {
    lock: async (url: string, mode: string) => { lockCalls.push([url, mode]); return { lockHandle: 'H1', LOCK_HANDLE: 'H1' }; },
    unLock: async (url: string, handle: string) => { unlockCalls.push(handle); }
  };
  const workflow = new MessageTextWorkflow({
    http: http as never, locks: locks as never, policy: policy as never, audit: audit as never
  });

  beforeEach(() => {
    audit.append.mockClear();
    http.request.mockClear();
    lockCalls.length = 0; unlockCalls.length = 0;
    serverMessages = [];
  });

  it('freezes a preview plan with old texts read from the feed', async () => {
    http.request.mockResolvedValue({ status: 200, body: XML, headers: {} });
    const preview = await workflow.preview({
      messageClass: 'ZMC_TEST', language: 'en', transport: 'S4HK900009',
      texts: [{ number: '001', text: 'Hello!' }]
    });
    // 只读预检 GET 带 Accept-Language 覆盖
    expect((http.request.mock.calls[0] as any)[1].headers['Accept-Language']).toBe('EN');
    expect(preview.status).toBe('preview');
    const plan = (preview as any).plan;
    expect(plan).toMatchObject({ messageClass: 'ZMC_TEST', language: 'EN', status: 'PREVIEWED' });
    expect(plan.oldTexts).toHaveLength(2);
  });

  it('applies a confirmed plan: object lock + PUT via application/* + readback', async () => {
    // 有状态 mock：模拟 SAP 端 PUT 后消息集变更。
    // 锁协议（真机实证 2026-09-24）：只用对象级 LOCK；PUT 的 Content-Type 必须是
    // application/*（mc 专用媒体类型会被服务端静默忽略），query 携带 lockHandle/corrNr。
    http.request.mockImplementation(async (url: string, init: { method: string; headers?: Record<string, string>; body?: string; qs?: Record<string, string> }) => {
      if (init.method === 'PUT') {
        // 从 PUT body 提取消息行并存入模拟状态
        const matches = [...(init.body ?? '').matchAll(/mc:msgno="([^"]*)"\s+mc:msgtext="([^"]*)"/g)];
        serverMessages = matches.map(m => ({ msgno: m[1], msgtext: m[2] }));
      }
      const messagesXml = serverMessages.map(m => `<mc:messages mc:msgno="${m.msgno}" mc:msgtext="${m.msgtext}"/>`).join('');
      return { status: 200, body: `<?xml?><mc:messageClass>${messagesXml}</mc:messageClass>`, headers: {} };
    });
    const preview = await workflow.preview({
      messageClass: 'ZMC_TEST', language: 'EN', transport: 'S4HK900009',
      texts: [{ number: '001', text: 'Hello!' }]
    });
    const applied = await workflow.applyConfirmed((preview as any).plan.messageTextPlanId);
    expect(applied.status).toBe('success');
    // PUT 契约：query 级对象锁句柄 + corrNr；Content-Type application/*
    const put = (http.request.mock.calls.find(([, init]: any) => init.method === 'PUT') as any);
    expect(put[1].qs).toEqual({ lockHandle: 'H1', corrNr: 'S4HK900009' });
    expect(put[1].headers['Content-Type']).toBe('application/*');
    expect(put[1].body).toContain('mc:msgno="001"');
    expect(put[1].body).toContain('mc:msgtext="Hello!"');
    // apply 尾部必须释放对象锁（标准 UNLOCK 带句柄）
    expect(unlockCalls).toEqual(['H1']);
  });

  it('releases the object lock even when the PUT fails', async () => {
    // PUT 失败按 UNKNOWN_OUTCOME 终止，但 finally 的对象锁释放必须执行
    http.request
      .mockResolvedValueOnce({ status: 200, body: '<?xml?><mc:messageClass></mc:messageClass>', headers: {} })
      .mockRejectedValueOnce(new Error('PUT failed'));
    const preview = await workflow.preview({
      messageClass: 'ZMC_TEST', language: 'EN', texts: [{ number: '001', text: 'x' }]
    });
    await expect(workflow.applyConfirmed((preview as any).plan.messageTextPlanId))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(workflow.status((preview as any).plan.messageTextPlanId).status).toBe('UNKNOWN_OUTCOME');
    // 底层错误透传进 message（真机排障必需），对象锁仍被释放
    expect(unlockCalls).toEqual(['H1']);
  });

  it('short-circuits when the new texts match the current value (no lock, no write)', async () => {
    http.request.mockResolvedValue({ status: 200, body: XML, headers: {} });
    const preview = await workflow.preview({
      messageClass: 'ZMC_TEST', language: 'EN', texts: [{ number: '001', text: 'Hello' }, { number: '002', text: 'World' }]
    });
    const applied = await workflow.applyConfirmed((preview as any).plan.messageTextPlanId);
    expect(applied.sameValue).toBe(true);
    expect(lockCalls).toHaveLength(0);
  });

  it('terminates with UNKNOWN_OUTCOME when the PUT fails (no auto retry)', async () => {
    http.request
      .mockResolvedValueOnce({ status: 200, body: XML, headers: {} })
      .mockRejectedValueOnce(new Error('PUT failed'));
    const preview = await workflow.preview({
      messageClass: 'ZMC_TEST', language: 'EN', texts: [{ number: '001', text: 'x' }]
    });
    await expect(workflow.applyConfirmed((preview as any).plan.messageTextPlanId))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(workflow.status((preview as any).plan.messageTextPlanId).status).toBe('UNKNOWN_OUTCOME');
  });

  it('rejects replay and validates inputs before SAP access', async () => {
    await expect(workflow.applyConfirmed('nonexistent')).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    await expect(workflow.preview({
      messageClass: 'BAD NAME', language: 'EN', texts: [{ number: '001', text: 'x' }]
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(workflow.preview({
      messageClass: 'ZMC', language: 'ENG', texts: [{ number: '001', text: 'x' }]
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
}

);

describe('MessageTextHandlers', () => {
  const workflow = { preview: jest.fn(), applyConfirmed: jest.fn(), status: jest.fn() };
  const elicit = jest.fn();
  const handlers = new MessageTextHandlers(workflow as never, {
    supportsFormElicitation: () => true,
    elicitInput: elicit as (p: ElicitRequestFormParams, t: number) => Promise<ElicitResult>
  });

  beforeEach(() => jest.clearAllMocks());

  it('publishes three tools with correct operation classes', () => {
    const tools = handlers.getTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'applyMessageTextChange', 'getMessageTextChangeStatus', 'previewMessageTextChange'
    ]);
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    expect(byName.previewMessageTextChange._meta.operationClass).toBe('read-only tenant');
    expect(byName.applyMessageTextChange._meta).toEqual({ operationClass: 'mutating tenant', approvalRequired: true });
    expect(byName.getMessageTextChangeStatus._meta.operationClass).toBe('local-only');
  });

  it('honors confirmation cancellation and passes acceptance through', async () => {
    workflow.status.mockReturnValue({ messageTextPlanId: 'p1', newTexts: [{ number: '001', text: 'x' }] });
    elicit.mockResolvedValue({ action: 'cancel' });
    await expect(handlers.handle('applyMessageTextChange', { messageTextPlanId: 'p1' }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(workflow.applyConfirmed).not.toHaveBeenCalled();

    elicit.mockResolvedValue({ action: 'accept', content: { decision: 'apply' } });
    workflow.applyConfirmed.mockResolvedValue({ status: 'success' });
    await handlers.handle('applyMessageTextChange', { messageTextPlanId: 'p1' });
    expect(workflow.applyConfirmed).toHaveBeenCalledWith('p1');
  });

  it('rejects apply without plan id and unknown tools', async () => {
    await expect(handlers.handle('applyMessageTextChange', {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('unknown', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
}
);
