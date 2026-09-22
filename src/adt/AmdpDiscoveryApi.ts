/**
 * AMDP 调试器可用性探测（矩阵行 debug.amdp-adt 的 amdp-discovery-spike）。
 *
 * VSP 来源（只读对照）：pkg/adt/features.go probeAMDP（第 275-305 行）与
 * internal/mcp/handlers_amdp_adt.go（ADT 原生 AMDP 调试四动作）。
 *
 * 关键事实（VSP 实测注释，本实现的语义基础）：
 *   - ADT 原生 AMDP 调试资源为 /sap/bc/adt/amdp/debugger/main，服务端**无需
 *     安装任何对象**（区别于 ZADT_VSP helper 路径）；
 *   - 无 mainId 的 GET：**400 = 资源存在**（它在要求 mainId 参数，探测不应
 *     伪造）；404 = 资源缺失；200/405 = 可用；
 *   - VSP 曾探错路径（/sap/bc/adt/debugger/amdp/sessions，任何系统都 404），
 *     导致 AMDP 被普遍误报不可用——本实现对齐正确路径；
 *   - 调试句柄存于 ABAP 会话内存（class-data）：未来实现 start/breakpoint 等
 *     必须复用同一有状态会话（本项目 ADTClient 默认 stateful，满足）；discovery
 *     本身为无状态 GET，不受该约束。
 *
 * 范围注记：本能力只回答"目标系统是否具备 AMDP 原生调试资源"；调试会话
 * （start/breakpoint/await/stop）为后续受控工作流，不在本轮。
 */
import type { AdtHTTP } from './AdtHTTP.js';

export interface AmdpDebuggerCheck {
  /** available = 目标系统具备 AMDP 原生调试资源；unavailable = 资源缺失；unknown = 探测失败。 */
  availability: 'available' | 'unavailable' | 'unknown';
  /** 人类可读的判定说明（对齐 VSP 的 message 语义）。 */
  message: string;
  /** 依据的 HTTP 状态码或错误类别（供调用方审计）。 */
  evidence: string;
}

/**
 * 探测 AMDP 原生调试资源（无状态 GET，零副作用）。
 * 状态码语义对齐 VSP probeAMDP：400/200/405 → available；404 → unavailable；
 * 其余状态码 → unknown（"not responding"）；网络/传输异常 → unknown + 错误类别
 * （异常文本不外泄底层细节）。
 */
export async function checkAmdpDebugger(h: AdtHTTP): Promise<AmdpDebuggerCheck> {
  let outcome: { availability: AmdpDebuggerCheck['availability']; message: string; evidence: string }
  try {
    const response = await h.request('/sap/bc/adt/amdp/debugger/main', { method: 'GET' })
    const status = Number(response.status)
    if (status === 400) {
      // 400 是资源在回答：它要求 mainId——探测不伪造 mainId，存在即结论
      outcome = { availability: 'available', message: 'AMDP debugger available', evidence: `HTTP ${status}` }
    } else if (status === 200 || status === 405) {
      outcome = { availability: 'available', message: 'AMDP debugger available', evidence: `HTTP ${status}` }
    } else if (status === 404) {
      outcome = { availability: 'unavailable', message: 'AMDP debugger endpoint not available', evidence: `HTTP ${status}` }
    } else {
      outcome = { availability: 'unknown', message: 'AMDP debugger not responding', evidence: `HTTP ${status}` }
    }
  } catch (error) {
    // 本项目 ADT 客户端把非 2xx 转成业务 Error：400 的响应体文本即
    // "Parameter mainId could not be found"（真机实测）——资源在说出它要的
    // 参数，这正是存在性证据；404/资源未知的文本才是不存在。网络/认证/超时
    // 归为 unknown，不外泄底层细节。
    const message = error instanceof Error ? error.message : String(error)
    // 匹配用 includes 而非正则：消息内容为 ADT 错误文本，子串判定足够且
    // 不受转义形态影响（'mainId' = 400 的参数提示 = 资源存在的直接证据）
    if (message.includes('mainId') || message.includes('400')) {
      outcome = { availability: 'available', message: 'AMDP debugger available', evidence: 'HTTP 400 (mainId required)' }
    } else if (message.includes('404')) {
      outcome = { availability: 'unavailable', message: 'AMDP debugger endpoint not available', evidence: 'HTTP 404' }
    } else {
      outcome = { availability: 'unknown', message: 'AMDP debugger probe failed (transport error)', evidence: 'transport error' }
    }
  }
  return outcome
}

/** 绑定 AdtHTTP 会话为窄客户端（风格对齐 CdsDependencyApi.createCdsAnalysisClient）。 */
export interface AmdpDiscoveryClient {
  checkAmdpDebugger(): Promise<AmdpDebuggerCheck>
}

export function createAmdpDiscoveryClient(h: AdtHTTP): AmdpDiscoveryClient {
  return { checkAmdpDebugger: () => checkAmdpDebugger(h) }
}
