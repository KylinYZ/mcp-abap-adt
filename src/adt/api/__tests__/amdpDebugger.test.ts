/**
 * AMDP 原生调试协议层单测（src/adt/api/amdpDebugger.ts）。
 *
 * XML 样本按 VSP 真机逆向的响应形状构造（含命名空间前缀、重复 mainResponse、
 * ack 序列、ON_BREAK 全字段）——协议陷阱清单见 amdpDebugger.ts 头注。
 * 陷阱 3（ack 误判为 stop）与陷阱 1（mainId 在 Location 头）各有专门用例。
 */
import type { AdtHTTP } from '../../AdtHTTP';
import {
  amdpDebuggerAwaitStop,
  amdpDebuggerReadVariable,
  amdpDebuggerResume,
  amdpDebuggerStart,
  amdpDebuggerStep,
  amdpDebuggerSyncBreakpoints,
  amdpDebuggerTerminate,
  isScalarTruncated,
  mainIdFromLocation,
  parseCallStack,
  parseMainResponses,
  parseScalarValues,
  parseStopPosition,
  parseToggleVerdict,
  parseVariablesAtStop
} from '../amdpDebugger';

/** 可编程的假 AdtHTTP：按调用序出队响应/错误，并记录每次请求。 */
function fakeHttp(script: Array<{ status?: number; body?: string; headers?: Record<string, string>; error?: Error }>) {
  const calls: Array<{ url: string; config: Record<string, unknown> }> = [];
  const queue = [...script];
  const h = {
    request: jest.fn(async (url: string, config: Record<string, unknown> = {}) => {
      calls.push({ url, config });
      const next = queue.shift();
      if (!next) throw new Error('fake http: script exhausted');
      if (next.error) throw next.error;
      return {
        status: next.status ?? 200,
        body: next.body ?? '',
        headers: next.headers ?? {}
      };
    })
  };
  return { h: h as unknown as AdtHTTP, calls };
}

// ---------- VSP 真机形状 XML 样本 ----------

/** start 响应：body parameter 带 HANA_SESSION_ID（mainId 在响应头，不在 body）。 */
const START_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<amdpdbg:startResponse xmlns:amdpdbg="http://www.sap.com/adt/amdp/debugger">
  <amdpdbg:parameter key="HANA_SESSION_ID" value="hxehost:30015:402155"/>
  <amdpdbg:parameter key="CASCADE_MODE" value="FULL"/>
</amdpdbg:startResponse>`;

/** 断点同步后的 ack 队列：SYNC_BREAKPOINTS + ON_TOGGLE_BREAKPOINTS（判定 VALID）。 */
const ACK_QUEUE_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<amdpdbg:mainResponses xmlns:amdpdbg="http://www.sap.com/adt/amdp/debugger">
  <amdpdbg:mainResponse kind="SYNC_BREAKPOINTS"/>
  <amdpdbg:mainResponse kind="ON_TOGGLE_BREAKPOINTS">
    <amdpdbg:value>
      <amdpdbg:onToggleBreakpoints>
        <amdpdbg:breakpoints>
          <amdpdbg:breakpoint state="VALID"/>
        </amdpdbg:breakpoints>
      </amdpdbg:onToggleBreakpoints>
    </amdpdbg:value>
  </amdpdbg:mainResponse>
</amdpdbg:mainResponses>`;

/** GET_SCALAR_VALUES 应答包：requestId 匹配 + 值文本 + 截断 + NULL 三形态。 */
const SCALAR_VALUES_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<amdpdbg:mainResponses xmlns:amdpdbg="http://www.sap.com/adt/amdp/debugger">
  <amdpdbg:mainResponse kind="SYNC_BREAKPOINTS"/>
  <amdpdbg:mainResponse requestId="REQ-1" kind="GET_SCALAR_VALUES">
    <amdpdbg:value>
      <amdpdbg:scalarValues>
        <amdpdbg:scalarValue name="IV_MAX" type="INT" isNullValue="false" length="1" originalLength="1">3</amdpdbg:scalarValue>
        <amdpdbg:scalarValue name="LT_TEXT" type="NVARCHAR" isNullValue="false" length="5" originalLength="12">HELLO</amdpdbg:scalarValue>
        <amdpdbg:scalarValue name="X_NULL" type="NVARCHAR" isNullValue="true" length="0" originalLength="0"/>
      </amdpdbg:scalarValues>
    </amdpdbg:value>
  </amdpdbg:mainResponse>
</amdpdbg:mainResponses>`;

/** 拒绝断点的判定包：state != VALID 且带 errorMessage。 */
const REJECTED_VERDICT_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<amdpdbg:mainResponses xmlns:amdpdbg="http://www.sap.com/adt/amdp/debugger">
  <amdpdbg:mainResponse kind="ON_TOGGLE_BREAKPOINTS">
    <amdpdbg:value>
      <amdpdbg:onToggleBreakpoints>
        <amdpdbg:breakpoints>
          <amdpdbg:breakpoint state="INVALID" errorMessage="position is not a valid debug statement"/>
        </amdpdbg:breakpoints>
      </amdpdbg:onToggleBreakpoints>
    </amdpdbg:value>
  </amdpdbg:mainResponse>
</amdpdbg:mainResponses>`;

/** 停止事件包：位置 + 全部在域变量（标量+表）+ 调用栈（ABAP/native 双位置）。 */
const ON_BREAK_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<amdpdbg:mainResponses xmlns:amdpdbg="http://www.sap.com/adt/amdp/debugger">
  <amdpdbg:mainResponse kind="ON_BREAK" debuggeeId="hxehost:30015:402155:ctx:1">
    <amdpdbg:value>
      <amdpdbg:abapPosition procedureName="ZCL_AMDP_SMOKE=>GET_DATA" uri="/sap/bc/adt/oo/classes/zcl_amdp_smoke/source/main#start=41"/>
      <amdpdbg:variables>
        <amdpdbg:variable name="IV_CARRID" type="NVARCHAR" scope="input" isNullValue="false"/>
        <amdpdbg:variable name="LT_TABLE" type="TABLE" scope="local" isNullValue="false" tableHandle="00000042" tableLength="3" isTrimmed="false"/>
        <amdpdbg:variable name="::ROWCOUNT" type="INT" scope="system" isNullValue="true"/>
      </amdpdbg:variables>
      <amdpdbg:callstack>
        <amdpdbg:callstackEntry index="0" type="METHOD" isDebugCompiled="true">
          <amdpdbg:abapPosition procedureName="ZCL_AMDP_SMOKE=>GET_DATA" uri="/sap/bc/adt/oo/classes/zcl_amdp_smoke/source/main#start=41"/>
          <amdpdbg:nativePosition procedureName="ZCL_AMDP_SMOKE=>GET_DATA" schemaName="SAPHANADB" line="19"/>
        </amdpdbg:callstackEntry>
        <amdpdbg:callstackEntry index="1" type="METHOD" isDebugCompiled="false">
          <amdpdbg:abapPosition procedureName="ZCL_AMDP_SMOKE=>HELPER" uri="/sap/bc/adt/oo/classes/zcl_amdp_smoke/source/main#start=7"/>
          <amdpdbg:nativePosition procedureName="ZCL_AMDP_SMOKE=>HELPER" schemaName="SAPHANADB" line="3"/>
        </amdpdbg:callstackEntry>
      </amdpdbg:callstack>
    </amdpdbg:value>
  </amdpdbg:mainResponse>
</amdpdbg:mainResponses>`;

describe('amdpDebugger 协议层', () => {
  describe('mainIdFromLocation', () => {
    it('从 Location 头尾段提取 mainId（陷阱 1：mainId 只在响应头）', () => {
      expect(mainIdFromLocation('/sap/bc/adt/amdp/debugger/main/ABC-123')).toBe('ABC-123');
      expect(mainIdFromLocation('')).toBe('');
      expect(mainIdFromLocation('/sap/bc/adt/oo/classes/zcl_x/source/main')).toBe('');
    });
  });

  describe('amdpDebuggerStart', () => {
    it('POST main 资源并从 Location 头取 mainId、body 取 HANA_SESSION_ID', async () => {
      const { h, calls } = fakeHttp([
        { status: 201, body: START_BODY, headers: { location: '/sap/bc/adt/amdp/debugger/main/SESS-1' } }
      ]);
      const session = await amdpDebuggerStart(h, { user: 'devuser' });
      expect(session).toEqual({ mainId: 'SESS-1', hanaSessionId: 'hxehost:30015:402155' });
      expect(calls[0].url).toBe('/sap/bc/adt/amdp/debugger/main');
      expect(calls[0].config.method).toBe('POST');
      expect(calls[0].config.qs).toEqual({ requestUser: 'DEVUSER', stopExisting: 'true' });
    });

    it('stopExisting=false 不携带该参数', async () => {
      const { h, calls } = fakeHttp([
        { headers: { location: '/sap/bc/adt/amdp/debugger/main/S2' } }
      ]);
      await amdpDebuggerStart(h, { user: 'DEVUSER', stopExisting: false });
      expect(calls[0].config.qs).toEqual({ requestUser: 'DEVUSER' });
    });

    it('Location 头缺席 = 协议失败（资源启动了却没报名字）', async () => {
      const { h } = fakeHttp([{ body: START_BODY }]);
      await expect(amdpDebuggerStart(h, { user: 'DEVUSER' }))
        .rejects.toThrow(/Location header/);
    });

    it('user 为空拒止', async () => {
      const { h } = fakeHttp([]);
      await expect(amdpDebuggerStart(h, { user: '  ' })).rejects.toThrow(/user is required/);
    });
  });

  describe('amdpDebuggerSyncBreakpoints', () => {
    it('构造 bpsync.v1+xml 同步包：小写类名 URI + CLAS/OC + FULL（默认）', async () => {
      const { h, calls } = fakeHttp([{ status: 200 }]);
      await amdpDebuggerSyncBreakpoints(h, 'SESS-1', [{ class: 'zcl_amdp_smoke', line: 41 }]);
      const call = calls[0];
      expect(call.url).toBe('/sap/bc/adt/amdp/debugger/main/SESS-1/breakpoints');
      expect(call.config.headers).toMatchObject({
        'Content-Type': 'application/vnd.sap.adt.amdp.dbg.bpsync.v1+xml'
      });
      const body = String(call.config.body);
      expect(body).toContain('amdpdbg:syncMode="FULL"');
      expect(body).toContain('adtcore:uri="/sap/bc/adt/oo/classes/zcl_amdp_smoke/source/main#start=41"');
      expect(body).toContain('adtcore:name="ZCL_AMDP_SMOKE"');
      expect(body).toContain('adtcore:type="CLAS/OC"');
      expect(body).toContain('amdpdbg:clientId="mcp-abap-adt-1"');
    });

    it('PROGRAM 模式透传；非法 syncMode 拒止', async () => {
      const { h, calls } = fakeHttp([{ status: 200 }]);
      await amdpDebuggerSyncBreakpoints(h, 'S', [{ class: 'A', line: 1 }], 'PROGRAM');
      expect(String(calls[0].config.body)).toContain('amdpdbg:syncMode="PROGRAM"');
      const { h: h2 } = fakeHttp([]);
      await expect(amdpDebuggerSyncBreakpoints(h2, 'S', [{ class: 'A', line: 1 }], 'PARTIAL' as never))
        .rejects.toThrow(/FULL or PROGRAM/);
    });

    it('空断点集与非法行号拒止（不发出请求）', async () => {
      const { h, calls } = fakeHttp([]);
      await expect(amdpDebuggerSyncBreakpoints(h, 'S', [])).rejects.toThrow(/at least one breakpoint/);
      await expect(amdpDebuggerSyncBreakpoints(h, 'S', [{ class: 'A', line: 0 }])).rejects.toThrow(/positive integer/);
      expect(calls).toHaveLength(0);
    });

    it('无 mainId 拒止（先 AMDP_START 的协议前提）', async () => {
      const { h } = fakeHttp([]);
      await expect(amdpDebuggerSyncBreakpoints(h, '', [{ class: 'A', line: 1 }]))
        .rejects.toThrow(/start one first/);
    });
  });

  describe('amdpDebuggerResume / parseMainResponses', () => {
    it('GET main/{mainId} 并解析事件序列（根元素名无关）', async () => {
      const { h, calls } = fakeHttp([{ body: ACK_QUEUE_BODY }]);
      const result = await amdpDebuggerResume(h, 'SESS-1');
      expect(calls[0].url).toBe('/sap/bc/adt/amdp/debugger/main/SESS-1');
      expect(calls[0].config.method).toBe('GET');
      expect(result.events).toEqual([
        { kind: 'SYNC_BREAKPOINTS', debuggeeId: undefined, requestId: undefined },
        { kind: 'ON_TOGGLE_BREAKPOINTS', debuggeeId: undefined, requestId: undefined }
      ]);
    });

    it('parseMainResponses 对空 body 返回空序列', () => {
      expect(parseMainResponses('')).toEqual([]);
    });
  });

  describe('amdpDebuggerAwaitStop', () => {
    it('跳过 ack（陷阱 3）：SYNC_BREAKPOINTS/ON_TOGGLE_BREAKPOINTS 后继续问，直到 ON_BREAK', async () => {
      const { h } = fakeHttp([
        { body: ACK_QUEUE_BODY },            // 第一批：同步 ack + 判定 VALID
        { body: ACK_QUEUE_BODY },            // 第二批：仍是 ack（判定已入队列的历史回放）
        { body: ON_BREAK_BODY }              // 第三批：真正的停止事件
      ]);
      const result = await amdpDebuggerAwaitStop(h, 'SESS-1');
      expect(result.stopped).toBe(true);
      expect(result.stop).toMatchObject({
        debuggeeId: 'hxehost:30015:402155:ctx:1',
        procedure: 'ZCL_AMDP_SMOKE=>GET_DATA',
        line: 41
      });
      expect(result.breakpointVerdict).toEqual({ state: 'VALID' });
      expect(result.variables).toHaveLength(3);
      expect(result.callStack).toHaveLength(2);
      // 事件序列完整保留（审计与排障依据）
      expect(result.events.map(e => e.kind)).toEqual([
        'SYNC_BREAKPOINTS', 'ON_TOGGLE_BREAKPOINTS',
        'SYNC_BREAKPOINTS', 'ON_TOGGLE_BREAKPOINTS',
        'ON_BREAK'
      ]);
    });

    it('判定包拒绝断点时如实回报（拒绝 ≠ 没跑）', async () => {
      const { h } = fakeHttp([
        { body: REJECTED_VERDICT_BODY },
        { error: new Error('HTTP 400: initial response') }
      ]);
      const result = await amdpDebuggerAwaitStop(h, 'SESS-1');
      expect(result.stopped).toBe(false);
      expect(result.breakpointVerdict).toEqual({
        state: 'INVALID',
        reason: 'position is not a valid debug statement'
      });
      expect(result.note).toMatch(/nothing stopped yet/);
    });

    it('队列空（资源异常）= 未等到的观察结果，非硬失败', async () => {
      const { h } = fakeHttp([{ error: new Error('HTTP 400: no data available') }]);
      const result = await amdpDebuggerAwaitStop(h, 'SESS-1');
      expect(result.stopped).toBe(false);
      expect(result.variables).toEqual([]);
      expect(result.note).toMatch(/debuggee may not have run/);
    });

    it('预算耗尽返回 stopped=false 并说明预算', async () => {
      const script = Array.from({ length: 3 }, () => ({ body: ACK_QUEUE_BODY }));
      const { h } = fakeHttp(script);
      const result = await amdpDebuggerAwaitStop(h, 'SESS-1', 3);
      expect(result.stopped).toBe(false);
      expect(result.note).toMatch(/within 3 answers/);
    });

    it('maxEvents 边界收敛：非法值回落默认 12，上限 50', async () => {
      const { h, calls } = fakeHttp([{ error: new Error('empty') }]);
      await amdpDebuggerAwaitStop(h, 'SESS-1', 0);
      await amdpDebuggerAwaitStop(h, 'SESS-1', 999);
      expect(calls).toHaveLength(2); // 每次调用各只发一个 GET（首包即异常/收敛）
    });
  });

  describe('amdpDebuggerStep', () => {
    it('POST debuggees/{id}?step=over|continue；非法步进拒止（SQLScript 无 into）', async () => {
      const { h, calls } = fakeHttp([{ status: 200 }, { status: 200 }]);
      await amdpDebuggerStep(h, 'SESS-1', 'dg-1', 'over');
      await amdpDebuggerStep(h, 'SESS-1', 'dg-2', 'continue');
      expect(calls[0].url).toBe('/sap/bc/adt/amdp/debugger/main/SESS-1/debuggees/dg-1?step=over');
      expect(calls[1].url).toBe('/sap/bc/adt/amdp/debugger/main/SESS-1/debuggees/dg-2?step=continue');
      const { h: h2 } = fakeHttp([]);
      await expect(amdpDebuggerStep(h2, 'S', 'dg', 'into' as never)).rejects.toThrow(/over or continue/);
      await expect(amdpDebuggerStep(h2, 'S', '', 'over')).rejects.toThrow(/no debuggee/);
    });
  });

  describe('amdpDebuggerReadVariable', () => {
    it('GET variables/{name}?offset=0&length=8192 → Location 头 requestId → 排空队列匹配后解析标量', async () => {
      const { h, calls } = fakeHttp([
        { status: 200, headers: { location: 'REQ-1' } },   // 读受理：Location 给 requestId，body 空
        { body: ACK_QUEUE_BODY },                            // 前置 ack（应被跳过）
        { body: SCALAR_VALUES_BODY }                         // requestId 应答包
      ]);
      const scalars = await amdpDebuggerReadVariable(h, 'SESS-1', 'dg-1', 'iv_max');
      expect(calls[0].url).toBe('/sap/bc/adt/amdp/debugger/main/SESS-1/debuggees/dg-1/variables/IV_MAX?offset=0&length=8192');
      expect(scalars).toHaveLength(3);
      expect(scalars[0]).toMatchObject({ name: 'IV_MAX', type: 'INT', value: '3', isNull: false });
      expect(scalars[1]).toMatchObject({ name: 'LT_TEXT', value: 'HELLO', length: 5, originalLength: 12 });
      expect(isScalarTruncated(scalars[1])).toBe(true);
      expect(isScalarTruncated(scalars[0])).toBe(false);
      expect(scalars[2]).toMatchObject({ name: 'X_NULL', isNull: true, value: '' });
    });

    it('无 Location 头（受理无回执）与预算内无应答各自报错', async () => {
      const { h } = fakeHttp([{ status: 200 }]);
      await expect(amdpDebuggerReadVariable(h, 'S', 'dg', 'X')).rejects.toThrow(/without a request id/);
      const { h: h2 } = fakeHttp([
        { status: 200, headers: { location: 'REQ-9' } },
        { body: ACK_QUEUE_BODY },
        { body: ACK_QUEUE_BODY }
      ]);
      await expect(amdpDebuggerReadVariable(h2, 'S', 'dg', 'X', 2)).rejects.toThrow(/no answer to request/);
    });

    it('parseScalarValues：不带 requestId 时解析全部应答包；空 body 返回空', () => {
      expect(parseScalarValues(SCALAR_VALUES_BODY)).toHaveLength(3);
      expect(parseScalarValues('')).toEqual([]);
    });
  });

  describe('amdpDebuggerTerminate', () => {
    it('DELETE main/{mainId}，hardStop 默认 true', async () => {
      const { h, calls } = fakeHttp([{ status: 200 }]);
      await amdpDebuggerTerminate(h, 'SESS-1');
      expect(calls[0].url).toBe('/sap/bc/adt/amdp/debugger/main/SESS-1?hardStop=true');
      expect(calls[0].config.method).toBe('DELETE');
    });

    it('hardStop=false 不带该参数；无 mainId 拒止', async () => {
      const { h, calls } = fakeHttp([{ status: 200 }]);
      await amdpDebuggerTerminate(h, 'SESS-1', false);
      expect(calls[0].url).toBe('/sap/bc/adt/amdp/debugger/main/SESS-1');
      const { h: h2 } = fakeHttp([]);
      await expect(amdpDebuggerTerminate(h2, ' ')).rejects.toThrow(/start one first/);
    });
  });

  describe('ON_BREAK 明细解析器', () => {
    it('parseStopPosition：过程名 + uri + #start= 行号 + debuggeeId', () => {
      const position = parseStopPosition(ON_BREAK_BODY);
      expect(position).toMatchObject({
        debuggeeId: 'hxehost:30015:402155:ctx:1',
        procedure: 'ZCL_AMDP_SMOKE=>GET_DATA',
        uri: '/sap/bc/adt/oo/classes/zcl_amdp_smoke/source/main#start=41',
        line: 41
      });
    });

    it('parseVariablesAtStop：布尔/数值属性容错（parseAttributeValue 数值化）+ 表变量识别', () => {
      const variables = parseVariablesAtStop(ON_BREAK_BODY);
      expect(variables).toHaveLength(3);
      expect(variables[0]).toMatchObject({ name: 'IV_CARRID', scope: 'input', isNull: false });
      expect(variables[0].tableHandle).toBeUndefined();
      expect(variables[1]).toMatchObject({
        name: 'LT_TABLE', tableHandle: '00000042', tableLength: 3, isTrimmed: false
      });
      expect(variables[2]).toMatchObject({ name: '::ROWCOUNT', isNull: true });
    });

    it('parseCallStack：ABAP 行 + native 行/schema + debugCompiled 标志', () => {
      const frames = parseCallStack(ON_BREAK_BODY);
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatchObject({
        index: 0, procedure: 'ZCL_AMDP_SMOKE=>GET_DATA', line: 41,
        nativeLine: 19, schema: 'SAPHANADB', debugCompiled: true
      });
      expect(frames[1]).toMatchObject({
        index: 1, procedure: 'ZCL_AMDP_SMOKE=>HELPER', line: 7, debugCompiled: false
      });
    });

    it('parseToggleVerdict：plural 层级（breakpoints>breakpoint）必须命中', () => {
      expect(parseToggleVerdict(ACK_QUEUE_BODY)).toEqual({ state: 'VALID' });
      expect(parseToggleVerdict('')).toBeUndefined();
    });
  });
});
