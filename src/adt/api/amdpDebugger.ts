/**
 * ADT 原生 AMDP（HANA SQLScript）调试协议层——矩阵行 debug.amdp-adt 的
 * amdp-debugger-controlled-workflow 实现。
 *
 * 协议来源（只读对照 + 真机逆向结论）：VSP pkg/saprfc/amdp.go 与
 * internal/mcp/handlers_amdp_adt.go。服务端零安装：全部请求打在
 * /sap/bc/adt/amdp/debugger/*，不依赖任何 ZADT_VSP helper 对象。
 *
 * 协议陷阱清单（VSP 真机踩坑注释的中文归纳，实现语义的依据）：
 *   1. start 的 mainId 只在 Location 响应头（/sap/bc/adt/amdp/debugger/main/{mainId}）；
 *      body 里的 HANA_SESSION_ID 是 HANA 侧会话（host:port:session），两者不是一回事。
 *   2. start 必须带 stopExisting=true 清理同用户遗留会话：二次 start 不带它失败，
 *      崩溃客户端残留会阻塞到超时。
 *   3. 断点同步后响应队列头部必是 ack（SYNC_BREAKPOINTS / ON_TOGGLE_BREAKPOINTS）——
 *      把 ack 当 stop 会误判"断点没命中"而 debuggee 正堵在断点上。awaitStop 必须
 *      跳过 ack 继续问。
 *   4. ON_TOGGLE_BREAKPOINTS 的 state=VALID 表示"位置被接受"，不等于"已命中"。
 *   5. 队列空时资源端异常（非 200）：语义是"还没有东西跑起来"，不是硬故障。
 *   6. 断点 URI 是普通 adtcore 引用：/sap/bc/adt/oo/classes/<小写类名>/source/main#start=<行>，
 *      对象 type 固定 CLAS/OC；XML 媒体类型 application/vnd.sap.adt.amdp.dbg.bpsync.v1+xml；
 *      syncMode 只认 FULL（全量替换）/PROGRAM（程序域），其他报 INVALID SYNCMODE——v1 仅 FULL。
 *   7. 调试句柄（mainId/控制句柄）存于 ABAP 会话内存（class-data）：本层全部函数
 *      必须跑在同一 AdtHTTP stateful 会话上；受控链 apply 恒挂写槽绑定 stateful
 *      主会话，天然满足。
 *
 * v1 范围：start / syncBreakpoints / awaitStop（基于 resume）/ terminate 四操作，
 * 对齐 VSP 的 AMDP_ADT_* MCP 面。step（POST .../debuggees/{id}?step=over|continue）、
 * 变量分页读取（GET .../debuggees/{id}/variables/{name}?offset=0&length=8192 →
 * Location 头 requestId → resume 等答）与表变量数据预览留作后续——stop 事件自带
 * 变量清单与调用栈，四操作已覆盖核心调试需求；表变量预览资源 VSP 自证未打通。
 */
import type { AdtHTTP } from '../AdtHTTP.js';
import { fullParse } from '../utilities.js';

/** start 成功后的 AMDP 调试会话标识。 */
export interface AmdpDebugSession {
    /** 会话主键：后续 breakpoints/resume/terminate 全部挂在它下面（来自 Location 头）。 */
    mainId: string;
    /** HANA 侧会话（host:port:session）；它的存在证明 ABAP↔HANA 桥接已建立。 */
    hanaSessionId: string;
}

/** 一个 AMDP 断点的输入（协议要求的字段由类名 + 行号推导）。 */
export interface AmdpBreakpointInput {
    /** AMDP 方法所在类名（内部会大写规范化并生成小写 URI）。 */
    class: string;
    /** AMDP 方法体内的行号（ADT 源码行，1 起）。 */
    line: number;
    /**
     * 客户端断点 ID：SAP 原样回显，供客户端识别自己的断点。缺省用本项目固定值；
     * 受控链不允许调用方注入任意句柄，此字段仅内部使用。
     */
    clientId?: string;
}

/** 断点同步模式；资源类只认这两个值，其他报 INVALID SYNCMODE（藏在异常 subType）。 */
export type AmdpSyncMode = 'FULL' | 'PROGRAM';

/** 本项目的断点 clientId（对齐 VSP 的 "vsp-mcp-1" 惯例；不暴露为调用方参数）。 */
export const AMDP_BREAKPOINT_CLIENT_ID = 'mcp-abap-adt-1';

/** resume 单条队列事件（mainResponse 的属性投影）。 */
export interface AmdpResumeEvent {
    kind: string;
    debuggeeId?: string;
    requestId?: string;
}

/** resume 的完整结果：事件序列 + 该包原始 body（停止明细解析的依据）。 */
export interface AmdpResumeResult {
    events: AmdpResumeEvent[];
    body: string;
}

/** 断点判定：SAP 对同步断点的裁决（VALID=已接受，非命中；拒绝时带原因）。 */
export interface AmdpBreakpointVerdict {
    state: string;
    reason?: string;
}

/** stop 位置（ON_BREAK 的 abapPosition；行号取自 uri 的 #start= 片段）。 */
export interface AmdpStopPosition {
    debuggeeId: string;
    /** ABAP 面向的过程名 CLASS=>METHOD。 */
    procedure: string;
    uri: string;
    line: number;
}

/** stop 事件自带的在域变量（无需逐个读取即可知全貌）。 */
export interface AmdpVariableInfo {
    name: string;
    type: string;
    /** system / input / output / local；system 是 HANA 自有变量（::ROWCOUNT 等），多为噪音。 */
    scope: string;
    isNull: boolean;
    /** 非空且非 '0' 即表变量（标量为空/'0'）。 */
    tableHandle?: string;
    tableLength?: number;
    isTrimmed?: boolean;
}

/** 调用栈帧：同一语句有两个行号——ABAP 行（类源码）与 HANA native 行（生成过程）。 */
export interface AmdpFrame {
    index: number;
    /** ABAP 面向的过程名 CLASS=>METHOD。 */
    procedure: string;
    uri: string;
    line: number;
    /** 生成过程（SQLScript）内的行号。 */
    nativeLine?: number;
    /** 生成过程所在 schema（数据预览类资源按名索要）。 */
    schema?: string;
    /** 未 debug 编译的帧断点永远打不中——与"断点不工作"外观一致，必须如实报告。 */
    debugCompiled: boolean;
}

/** awaitStop 的结构化结果：观察成功 ≠ 命中。 */
export interface AmdpAwaitStopResult {
    /** true = debuggee 已停在断点/步进处；false = 预算内未等到（可再次 await 轮询）。 */
    stopped: boolean;
    /** 本次消费的队列事件序列（含 ack），审计与排障依据。 */
    events: AmdpResumeEvent[];
    /** 最近一次 ON_TOGGLE_BREAKPOINTS 的断点判定（即使没等到 stop 也值得回报）。 */
    breakpointVerdict?: AmdpBreakpointVerdict;
    /** 停止位置（仅 stopped=true）。 */
    stop?: AmdpStopPosition;
    /** stop 事件自带的在域变量（仅 stopped=true）。 */
    variables: AmdpVariableInfo[];
    /** stop 事件自带的调用栈（仅 stopped=true）。 */
    callStack: AmdpFrame[];
    /** 未等到时的说明（队列空/预算耗尽），供 agent 决定是否再轮询。 */
    note?: string;
}

/** XML 属性转义：对象名/URI 来自参数与远端响应，进入 XML 属性前必须转义。 */
function xmlAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 从 Location 头提取 mainId：/sap/bc/adt/amdp/debugger/main/{mainId}。 */
export function mainIdFromLocation(location: string): string {
    const marker = '/main/';
    const index = location.lastIndexOf(marker);
    if (index < 0) return '';
    return location.slice(index + marker.length).trim();
}

/** 读取响应头（大小写不敏感）：Location/location 都可能出现。 */
function responseHeader(headers: unknown, name: string): string {
    if (!headers || typeof headers !== 'object') return '';
    const record = headers as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (key.toLowerCase() === name.toLowerCase()) {
            const value = record[key];
            return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
        }
    }
    return '';
}

/**
 * start：建立 AMDP 调试会话。
 * stopExisting 语义对齐 VSP（默认 true）：清掉该用户已有会话，保证幂等重入；
 * mainId 缺席（Location 头没给）视为协议失败——资源启动了却没报名字。
 */
export async function amdpDebuggerStart(
    h: AdtHTTP,
    options: { user: string; stopExisting?: boolean }
): Promise<AmdpDebugSession> {
    const user = options.user.trim().toUpperCase();
    if (!user) throw new Error('amdp start: user is required');
    const stopExisting = options.stopExisting !== false;
    const qs: Record<string, unknown> = { requestUser: user };
    if (stopExisting) qs.stopExisting = 'true';
    const response = await h.request('/sap/bc/adt/amdp/debugger/main', {
        method: 'POST',
        qs,
        headers: { Accept: 'application/xml' }
    });
    const mainId = mainIdFromLocation(responseHeader(response.headers, 'location'));
    if (!mainId) {
        throw new Error('the AMDP debugger started without naming its session; expected it in the Location header');
    }
    return { mainId, hanaSessionId: amdpStartParameter(String(response.body ?? ''), 'HANA_SESSION_ID') };
}

/** 从 start 响应 body 的 parameter 列表取一个键值（key/value 均为属性）。 */
function amdpStartParameter(body: string, key: string): string {
    if (!body) return '';
    const parsed = fullParse(body, { removeNSPrefix: true, parseAttributeValue: false });
    for (const parameter of responseChildren(parsed, 'parameter')) {
        if (String(parameter?.['@_key'] ?? '').toUpperCase() === key.toUpperCase()) {
            return String(parameter?.['@_value'] ?? '');
        }
    }
    return '';
}

/**
 * syncBreakpoints：全量替换会话断点集。
 * syncMode v1 固定 FULL（默认）：FULL=该用户全量替换，PROGRAM=程序域；资源类拒绝其他值。
 * 返回 void：SAP 对断点位置的裁决不在这里给，而在后续 resume 的
 * ON_TOGGLE_BREAKPOINTS 事件里（awaitStop 负责收集）。
 */
export async function amdpDebuggerSyncBreakpoints(
    h: AdtHTTP,
    mainId: string,
    breakpoints: AmdpBreakpointInput[],
    syncMode: AmdpSyncMode = 'FULL'
): Promise<void> {
    requireMainId(mainId);
    if (!Array.isArray(breakpoints) || breakpoints.length === 0) {
        throw new Error('amdp breakpoints: at least one breakpoint is required');
    }
    if (syncMode !== 'FULL' && syncMode !== 'PROGRAM') {
        throw new Error(`amdp breakpoints: syncMode must be FULL or PROGRAM, got ${syncMode}`);
    }
    const items = breakpoints.map(breakpoint => {
        const className = breakpoint.class.trim().toUpperCase();
        if (!className) throw new Error('amdp breakpoints: class is required');
        const line = Number(breakpoint.line);
        if (!Number.isInteger(line) || line <= 0) {
            throw new Error(`amdp breakpoints: line must be a positive integer for ${className}`);
        }
        return {
            clientId: breakpoint.clientId?.trim() || AMDP_BREAKPOINT_CLIENT_ID,
            // 断点 URI 对齐 VSP：小写类名的普通 adtcore 源引用 + 行号片段
            uri: `/sap/bc/adt/oo/classes/${className.toLowerCase()}/source/main#start=${line}`,
            name: className,
            type: 'CLAS/OC'
        };
    });
    const body = breakpointSyncDocument(syncMode, items);
    await h.request(`/sap/bc/adt/amdp/debugger/main/${encodeURIComponent(mainId)}/breakpoints`, {
        method: 'POST',
        headers: {
            Accept: 'application/xml',
            'Content-Type': 'application/vnd.sap.adt.amdp.dbg.bpsync.v1+xml'
        },
        body
    });
}

/** 构造断点同步请求 XML（形状依据 amdp_dbg_adt_sync_bp_req 转换模板，非猜测）。 */
function breakpointSyncDocument(
    syncMode: AmdpSyncMode,
    items: Array<{ clientId: string; uri: string; name: string; type: string }>
): string {
    const parts = items.map(item =>
        `<amdpdbg:breakpoint amdpdbg:clientId="${xmlAttr(item.clientId)}"` +
        ` adtcore:uri="${xmlAttr(item.uri)}"` +
        ` adtcore:name="${xmlAttr(item.name)}"` +
        ` adtcore:type="${xmlAttr(item.type)}"/>`
    ).join('');
    return '<?xml version="1.0" encoding="UTF-8"?>' +
        '<amdpdbg:breakpointsSyncRequest xmlns:amdpdbg="http://www.sap.com/adt/amdp/debugger"' +
        ' xmlns:adtcore="http://www.sap.com/adt/core"' +
        ` amdpdbg:syncMode="${xmlAttr(syncMode)}">` +
        '<amdpdbg:breakpoints>' + parts + '</amdpdbg:breakpoints>' +
        '</amdpdbg:breakpointsSyncRequest>';
}

/**
 * resume：取响应队列的下一批 answer（GET，非长挂监听）。
 * 返回事件序列与该包原始 body——停止明细（位置/变量/调用栈）就嵌在停止事件
 * 所在的同一个包里，由调用方立即解析，不存在"重读队列"这回事。
 * 队列空时服务端异常（request 抛错）：本函数原样抛出，由 awaitStop 解释为
 * "还没有东西跑起来"；其他调用方不应吞掉该错误类别。
 */
export async function amdpDebuggerResume(h: AdtHTTP, mainId: string): Promise<AmdpResumeResult> {
    requireMainId(mainId);
    const response = await h.request(`/sap/bc/adt/amdp/debugger/main/${encodeURIComponent(mainId)}`, {
        method: 'GET',
        headers: { Accept: 'application/xml' }
    });
    const body = String(response.body ?? '');
    return { events: parseMainResponses(body), body };
}

/** ack 事件集合：关于会话而非停止的程序；把它们当 stop 是本 API 最大的陷阱。 */
const AMDP_ACKNOWLEDGEMENT_KINDS = new Set(['SYNC_BREAKPOINTS', 'ON_TOGGLE_BREAKPOINTS']);

/**
 * awaitStop：循环 resume 排空 ack，直到 debuggee 停止事件或预算耗尽。
 * - 默认 maxEvents=12（对齐 VSP：足够越过固定前置 ack，又能发现"什么都没停"），
 *   上限 50（每次 GET 快速返回，不构成服务端长挂起，规避 MCP 客户端超时）；
 * - 队列空（resume 抛错）→ 返回 stopped=false 的观察结果，不是硬失败；
 * - ON_TOGGLE_BREAKPOINTS 的断点判定随时收集——即使最终没等到 stop 也要回报，
 *   否则"断点被拒"与"方法没跑"看起来一模一样。
 */
export async function amdpDebuggerAwaitStop(
    h: AdtHTTP,
    mainId: string,
    maxEvents = 12
): Promise<AmdpAwaitStopResult> {
    requireMainId(mainId);
    const budget = Number.isInteger(maxEvents) && maxEvents > 0 ? Math.min(maxEvents, 50) : 12;
    const events: AmdpResumeEvent[] = [];
    let verdict: AmdpBreakpointVerdict | undefined;
    for (let i = 0; i < budget; i++) {
        let resume: AmdpResumeResult;
        try {
            resume = await amdpDebuggerResume(h, mainId);
        } catch (error) {
            // 队列空/资源异常："还没有东西停止"。观察成功但无命中，可再次轮询。
            return {
                stopped: false,
                events,
                breakpointVerdict: verdict,
                variables: [],
                callStack: [],
                note: `nothing stopped yet (${summarizeError(error)}); the debuggee may not have run`
            };
        }
        for (const event of resume.events) {
            events.push(event);
            if (event.kind === 'ON_TOGGLE_BREAKPOINTS') {
                const parsed = parseToggleVerdict(resume.body);
                if (parsed) verdict = parsed;
            }
            const isStop = event.debuggeeId && !AMDP_ACKNOWLEDGEMENT_KINDS.has(event.kind);
            if (isStop) {
                // 停止事件的明细（位置/变量/调用栈）就在本包 body 里：立即解析。
                return {
                    stopped: true,
                    events,
                    breakpointVerdict: verdict,
                    stop: parseStopPosition(resume.body),
                    variables: parseVariablesAtStop(resume.body),
                    callStack: parseCallStack(resume.body)
                };
            }
        }
    }
    return {
        stopped: false,
        events,
        breakpointVerdict: verdict,
        variables: [],
        callStack: [],
        note: `nothing stopped within ${budget} answers; the debuggee may not have run`
    };
}

/** terminate：结束 AMDP 调试会话；hardStop=true 不等待 debuggee（对齐 VSP 默认）。 */
export async function amdpDebuggerTerminate(
    h: AdtHTTP,
    mainId: string,
    hardStop = true
): Promise<void> {
    requireMainId(mainId);
    const uri = `/sap/bc/adt/amdp/debugger/main/${encodeURIComponent(mainId)}` +
        (hardStop ? '?hardStop=true' : '');
    await h.request(uri, {
        method: 'DELETE',
        headers: { Accept: 'application/xml' }
    });
}

/** 解析一次 resume 的 body：事件序列（供 awaitStop 消费）。 */
export function parseMainResponses(body: string): AmdpResumeEvent[] {
    if (!body) return [];
    const parsed = fullParse(body, { removeNSPrefix: true, isArray: name => name === 'mainResponse', parseAttributeValue: false });
    return responseChildren(parsed, 'mainResponse').map(entry => ({
        kind: String(entry?.['@_kind'] ?? ''),
        debuggeeId: optionalAttr(entry, 'debuggeeId'),
        requestId: optionalAttr(entry, 'requestId')
    }));
}

/** 解析 ON_TOGGLE_BREAKPOINTS 包：断点判定（取首个带 state 的断点）。 */
export function parseToggleVerdict(body: string): AmdpBreakpointVerdict | undefined {
    if (!body) return undefined;
    const parsed = fullParse(body, { removeNSPrefix: true, isArray: name => name === 'mainResponse', parseAttributeValue: false });
    for (const response of responseChildren(parsed, 'mainResponse')) {
        // 注意 plural 层级：value > onToggleBreakpoints > breakpoints > breakpoint；
        // 跳过 plural 层会静默找不到，读起来像"SAP 没说断点"而不是解析 bug。
        const toggle = response?.value?.onToggleBreakpoints;
        for (const breakpoint of asArray(toggle?.breakpoints?.breakpoint)) {
            const state = String(breakpoint?.['@_state'] ?? '');
            if (state) {
                const reason = String(breakpoint?.['@_errorMessage'] ?? '');
                return reason ? { state, reason } : { state };
            }
        }
    }
    return undefined;
}

/** 解析 ON_BREAK 包：停止位置（abapPosition；行号在 uri 的 #start= 片段）。 */
export function parseStopPosition(body: string): AmdpStopPosition | undefined {
    if (!body) return undefined;
    const parsed = fullParse(body, { removeNSPrefix: true, isArray: name => name === 'mainResponse', parseAttributeValue: false });
    for (const response of responseChildren(parsed, 'mainResponse')) {
        const position = response?.value?.abapPosition;
        const procedure = String(position?.['@_procedureName'] ?? '');
        const debuggeeId = String(response?.['@_debuggeeId'] ?? '');
        if (!procedure && !debuggeeId) continue;
        const uri = String(position?.['@_uri'] ?? '');
        return { debuggeeId, procedure, uri, line: lineFromUri(uri) };
    }
    return undefined;
}

/** 解析 ON_BREAK 包：在域变量清单（tableHandle 非空非 '0' 即表变量）。 */
export function parseVariablesAtStop(body: string): AmdpVariableInfo[] {
    if (!body) return [];
    const parsed = fullParse(body, { removeNSPrefix: true, isArray: name => name === 'mainResponse', parseAttributeValue: false });
    const out: AmdpVariableInfo[] = [];
    for (const response of responseChildren(parsed, 'mainResponse')) {
        const variables = response?.value?.variables?.variable;
        for (const variable of asArray(variables)) {
            out.push({
                name: String(variable?.['@_name'] ?? ''),
                type: String(variable?.['@_type'] ?? ''),
                scope: String(variable?.['@_scope'] ?? ''),
                isNull: isTrueAttr(variable, 'isNullValue'),
                tableHandle: orUndefined(String(variable?.['@_tableHandle'] ?? '')),
                tableLength: numberOfAttr(variable, 'tableLength'),
                isTrimmed: isTrueAttr(variable, 'isTrimmed')
            });
        }
    }
    return out;
}

/** 解析 ON_BREAK 包：调用栈（ABAP 位置 + native 位置 + debugCompiled 标志）。 */
export function parseCallStack(body: string): AmdpFrame[] {
    if (!body) return [];
    const parsed = fullParse(body, { removeNSPrefix: true, isArray: name => name === 'mainResponse', parseAttributeValue: false });
    const out: AmdpFrame[] = [];
    for (const response of responseChildren(parsed, 'mainResponse')) {
        const entries = response?.value?.callstack?.callstackEntry;
        for (const entry of asArray(entries)) {
            const abap: Record<string, unknown> = entry?.abapPosition ?? {};
            const native: Record<string, unknown> = entry?.nativePosition ?? {};
            const uri = String(abap['@_uri'] ?? '');
            out.push({
                index: numberOfAttr(entry, 'index') ?? out.length,
                procedure: String(abap['@_procedureName'] ?? ''),
                uri,
                line: lineFromUri(uri),
                nativeLine: numberOfAttr(native, 'line'),
                schema: orUndefined(String(native['@_schemaName'] ?? '')),
                debugCompiled: isTrueAttr(entry, 'isDebugCompiled')
            });
        }
    }
    return out;
}

// ---------- 内部工具 ----------

function requireMainId(mainId: string): void {
    if (!mainId || !mainId.trim()) {
        throw new Error('no AMDP debug session on this connection; start one first');
    }
}

/** fast-xml-parser 的重复元素可能成数组（isArray 指定）也可能单元素：统一成数组。 */
function asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

/**
 * 取重复子元素（mainResponse/parameter）：SAP 响应的根元素名不保证（VSP 的 Go
 * 解析按子元素名匹配），所以先看顶层，再看首个顶层包装对象（如 mainResponses）。
 * 条目按 Record<string, any> 返回——与 fullParse 的 any 语义一致，供解析器自由导航。
 */
function responseChildren(parsed: Record<string, unknown>, name: string): Array<Record<string, any>> {
    if (parsed[name] !== undefined) return toRecordArray(parsed[name]);
    for (const value of Object.values(parsed)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const child = (value as Record<string, unknown>)[name];
            if (child !== undefined) return toRecordArray(child);
        }
    }
    return [];
}

/** unknown 入参的显式收窄（避免 T | T[] 泛型推断歧义）：单元素/数组统一成对象数组。 */
function toRecordArray(value: unknown): Array<Record<string, any>> {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value as Array<Record<string, any>> : [value as Record<string, any>];
}

function optionalAttr(entry: unknown, name: string): string | undefined {
    const value = (entry as Record<string, unknown>)?.[`@_${name}`];
    const text = value === undefined || value === null ? '' : String(value);
    return text ? text : undefined;
}

/** parseAttributeValue=true 时布尔属性可能是 boolean 或字符串：统一判定。 */
function isTrueAttr(entry: unknown, name: string): boolean {
    const value = (entry as Record<string, unknown>)?.[`@_${name}`];
    return String(value ?? '').trim().toLowerCase() === 'true';
}

function numberOfAttr(entry: unknown, name: string): number | undefined {
    const value = (entry as Record<string, unknown>)?.[`@_${name}`];
    if (value === undefined || value === null || value === '') return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
}

function orUndefined(text: string): string | undefined {
    return text ? text : undefined;
}

/** ADT 位置的行号惯例：uri 片段 #start=<行>。 */
function lineFromUri(uri: string): number {
    const marker = '#start=';
    const index = uri.lastIndexOf(marker);
    if (index < 0) return 0;
    const parsed = Number.parseInt(uri.slice(index + marker.length), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** 错误归类摘要（不外泄底层堆栈，只留可读类别）。 */
function summarizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}
