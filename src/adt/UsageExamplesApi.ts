/**
 * usage-examples API（矩阵行 analysis.history 的 usage_examples 子操作；VSP
 * 来源 internal/mcp/handlers_graph.go 的 fetchUsageCallerSources +
 * pkg/graph/queries_examples.go 的 FindUsageExamples 语义移植）。
 *
 * 两段式给出"目标对象被怎么使用"的具体调用片段：
 *   Step 1（候选 callers）：按目标类型选择交叉表查询（CLAS/INTF 两表 LIKE、
 *     PROG/SUBMIT/FUNC 按 CROSS TYPE 单字符码精确），INCLUDE 归一化为候选
 *     对象（FUGR 不出片段——v1 边界，VSP 同）；每候选读源码，读不到/空源码
 *     记 unsearched 不计入 totalCallers。
 *   Step 2（片段提取，纯函数）：逐行匹配目标引用形态（CALL FUNCTION /
 *     class=>method / NEW / TYPE REF TO / SUBMIT / PERFORM），无形态命中时
 *     字面 grep 兜底（MEDIUM 置信）；注释行跳过；片段带前后 3 行行号上下文；
 *     排序为非测试优先、高置信优先、具体形态优先，maxExamples 截断。
 *
 * 与 VSP 的差异：候选不走 ADT CallGraph 首选路径（本项目无该端点封装），
 * 直接用交叉表回退口径（VSP 的 fallback 同款查询）；无包回填（TADIR 不查）。
 */
import { normalizeLoadName } from './LoadGraphApi.js'
import type { TransportHistoryQueryRunner } from './TransportHistoryApi.js'

/** 使用示例的目标（对象 + 可选组件）。 */
export interface UsageTarget {
  objectType: 'CLAS' | 'INTF' | 'PROG' | 'FUNC' | 'SUBMIT'
  objectName: string
  /** CLAS/INTF 场景可指定方法名（METHOD_CALL 形态匹配）。 */
  method?: string
  /** PROG 场景可指定子例程名（PERFORM form IN PROGRAM 形态匹配）。 */
  form?: string
}

/** 一个调用者及其源码。 */
export interface CallerSource {
  objectType: string
  objectName: string
  source: string
}

/** 一条使用示例（命中行 + 上下文片段）。 */
export interface UsageExample {
  callerObjectType: string
  callerObjectName: string
  lineNumber: number
  matchType: 'CALL_FUNCTION' | 'METHOD_CALL' | 'CLASS_REFERENCE' | 'SUBMIT' | 'PERFORM' | 'GREP'
  confidence: 'HIGH' | 'MEDIUM'
  snippet: string
}

/** getUsageExamples 的返回。 */
export interface GetUsageExamplesResult {
  target: UsageTarget
  totalCallers: number
  examples: UsageExample[]
  unsearched: Array<{ object: string; reason: string }>
  notes: string[]
}

/** 交叉表候选查询窄通道。 */
export type UsageExamplesSqlRunner = (sqlQuery: string, rowLimit: number) => Promise<{ values?: Record<string, unknown>[] }>

/** 源码读取窄通道（返回纯 ABAP 源文本）。 */
export type UsageExamplesSourceReader = (input: { objectType: string; objectName: string }) => Promise<string>

const QUERY_ROW_LIMIT = 500
const SNIPPET_CONTEXT_LINES = 3

const SUPPORTED_CALLER_TYPES = ['CLAS', 'INTF', 'PROG']

/** 单元格容错读取（同项目真机空值语义）。 */
function cellText(row: Record<string, unknown>, columnName: string): string {
  const keys = Object.keys(row).filter(k => k.toUpperCase() === columnName)
  if (keys.length !== 1) return ''
  const value = row[keys[0]]
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

/** 名字 token 校验。 */
function validateToken(value: unknown, capability: string, label: string, max: number): string {
  const token = String(value ?? '').trim().toUpperCase()
  if (!token || token.length > max || !/^[A-Z0-9_/]+$/.test(token)) {
    throw new Error(`${capability}: ${label} "${String(value ?? '')}" is invalid (A-Z 0-9 _ /, at most ${max} characters).`)
  }
  return token
}

/** ABAP 注释行（"*" 全行注释与 '"' 半行注释起始）。 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('*') || trimmed.startsWith('"')
}

/** CALL FUNCTION 'FM_NAME' 形态。 */
function matchCallFunction(lineUpper: string, fmName: string): boolean {
  return lineUpper.includes('CALL FUNCTION') && lineUpper.includes(`'${fmName}'`)
}

/** class=>method( / class->method( / intf~method( 形态。 */
function matchMethodCall(lineUpper: string, className: string, methodName: string): boolean {
  if (lineUpper.includes(`${className}=>${methodName}`)) return true
  if (lineUpper.includes(`->${methodName}`)) return true
  if (lineUpper.includes(`${className}~${methodName}`)) return true
  return false
}

/** NEW class / TYPE REF TO class / CREATE OBJECT TYPE class 形态。 */
function matchClassReference(lineUpper: string, className: string): boolean {
  if (lineUpper.includes(`NEW ${className}`)) return true
  if (lineUpper.includes(`TYPE REF TO ${className}`)) return true
  if (lineUpper.includes(`TYPE ${className}`) && lineUpper.includes('CREATE OBJECT')) return true
  return false
}

/** SUBMIT prog 形态。 */
function matchSubmit(lineUpper: string, progName: string): boolean {
  return lineUpper.includes(`SUBMIT ${progName}`)
}

/** PERFORM form IN PROGRAM prog 形态。 */
function matchPerformInProgram(lineUpper: string, progName: string, form: string): boolean {
  return lineUpper.includes(`PERFORM ${form}`) && lineUpper.includes(`IN PROGRAM ${progName}`)
}

/** 命中行前后各 contextLines 行的带行号片段。 */
function extractSnippet(lines: string[], targetIdx: number, contextLines: number): string {
  const start = Math.max(0, targetIdx - contextLines)
  const end = Math.min(lines.length, targetIdx + contextLines + 1)
  const out: string[] = []
  for (let i = start; i < end; i++) {
    out.push(`  ${String(i + 1).padStart(4)} | ${lines[i]}`)
  }
  return out.join('\n')
}

/**
 * 在单个 caller 源码里提取目标引用的调用点（VSP extractCallSites 移植）：
 * 按目标类型选具体形态匹配，未命中时字面 grep 兜底（MEDIUM 置信）。
 */
export function extractCallSites(target: UsageTarget, caller: CallerSource): UsageExample[] {
  const lines = caller.source.split('\n')
  const examples: UsageExample[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineUpper = line.toUpperCase()
    if (isCommentLine(line)) continue

    let matchType: UsageExample['matchType'] | '' = ''
    switch (target.objectType) {
      case 'FUNC':
        if (matchCallFunction(lineUpper, target.objectName)) matchType = 'CALL_FUNCTION'
        break
      case 'CLAS':
      case 'INTF':
        if (target.method) {
          if (matchMethodCall(lineUpper, target.objectName, target.method)) matchType = 'METHOD_CALL'
        } else if (matchClassReference(lineUpper, target.objectName)) {
          matchType = 'CLASS_REFERENCE'
        }
        break
      case 'SUBMIT':
        if (matchSubmit(lineUpper, target.objectName)) matchType = 'SUBMIT'
        break
      case 'PROG':
        if (target.form) {
          if (matchPerformInProgram(lineUpper, target.objectName, target.form)) matchType = 'PERFORM'
        } else if (matchSubmit(lineUpper, target.objectName)) {
          matchType = 'SUBMIT'
        }
        break
    }
    if (!matchType && lineUpper.includes(target.objectName)) {
      matchType = 'GREP'
    }
    if (matchType) {
      examples.push({
        callerObjectType: caller.objectType,
        callerObjectName: caller.objectName,
        lineNumber: i + 1,
        matchType,
        confidence: matchType === 'GREP' ? 'MEDIUM' : 'HIGH',
        snippet: extractSnippet(lines, i, SNIPPET_CONTEXT_LINES)
      })
    }
  }
  return examples
}

/** 排序键（VSP exampleRank 移植）：非测试优先、高置信优先、具体形态优先。 */
function exampleRank(e: UsageExample): number {
  let rank = 0
  if (/TEST/.test(e.callerObjectName)) rank += 100
  if (e.confidence === 'MEDIUM') rank += 50
  switch (e.matchType) {
    case 'CALL_FUNCTION': rank += 0; break
    case 'METHOD_CALL': rank += 1; break
    case 'SUBMIT': rank += 2; break
    case 'PERFORM': rank += 3; break
    case 'CLASS_REFERENCE': rank += 10; break
    case 'GREP': rank += 20; break
  }
  return rank
}

/**
 * usage-examples：给出目标对象被怎么使用的具体调用片段（有界）。
 * objectName 之外的 method/form 为可选组件（影响形态匹配）。
 */
export async function getUsageExamples(
  deps: { runSql: UsageExamplesSqlRunner; readSource: UsageExamplesSourceReader },
  input: UsageTarget & { maxExamples?: number }
): Promise<GetUsageExamplesResult> {
  const capability = 'getUsageExamples'
  const objectType = String(input?.objectType ?? '').trim().toUpperCase()
  if (!['CLAS', 'INTF', 'PROG', 'FUNC', 'SUBMIT'].includes(objectType)) {
    throw new Error(`${capability}: objectType must be one of CLAS, INTF, PROG, FUNC.`)
  }
  const objectName = validateToken(input?.objectName, capability, 'objectName', 40)
  const method = input?.method === undefined ? undefined : validateToken(input.method, capability, 'method', 61)
  const form = input?.form === undefined ? undefined : validateToken(input.form, capability, 'form', 30)
  const maxExamples = Math.min(Math.max(Number.isInteger(input?.maxExamples) ? input!.maxExamples! : 10, 1), 50)
  const target: UsageTarget = { objectType: objectType as UsageTarget['objectType'], objectName, ...(method ? { method } : {}), ...(form ? { form } : {}) }
  const unsearched: Array<{ object: string; reason: string }> = []
  const notes = [
    'Candidates come from the cross-reference tables (CROSS one-char TYPE codes; WBCROSSGT for CLAS/INTF); FUGR callers are excluded from snippets (v1 boundary).',
    'confirmed match types are structural (CALL_FUNCTION/METHOD_CALL/CLASS_REFERENCE/SUBMIT/PERFORM); GREP entries are literal name hits with MEDIUM confidence.',
    'Sequential reads are not an atomic snapshot; no package ownership metadata is resolved in this layer.'
  ]

  // Step 1：候选 callers（交叉表查询按目标类型选择，对齐 VSP fallback 口径）
  const queries: string[] = []
  switch (objectType) {
    case 'FUNC':
      queries.push(`SELECT INCLUDE, TYPE, NAME FROM CROSS WHERE NAME = '${objectName}' AND TYPE = 'F'`)
      break
    // CROSS.TYPE 单字符码：R=report(SUBMIT)、U=PERFORM；PERFORM 行 NAME=form
    case 'PROG':
      queries.push(form
        ? `SELECT INCLUDE, TYPE, NAME FROM CROSS WHERE NAME = '${form}' AND TYPE = 'U'`
        : `SELECT INCLUDE, TYPE, NAME FROM CROSS WHERE NAME = '${objectName}' AND TYPE = 'R'`)
      break
    case 'SUBMIT':
      queries.push(`SELECT INCLUDE, TYPE, NAME FROM CROSS WHERE NAME = '${objectName}' AND TYPE = 'R'`)
      break
    case 'CLAS':
    case 'INTF':
      queries.push(`SELECT INCLUDE, OTYPE, NAME FROM WBCROSSGT WHERE NAME LIKE '${objectName}%'`)
      queries.push(`SELECT INCLUDE, TYPE AS OTYPE, NAME FROM CROSS WHERE NAME LIKE '${objectName}%'`)
      break
  }

  const candidates = new Map<string, { objectType: string; objectName: string }>()
  for (const sql of queries) {
    try {
      const rows = (await deps.runSql(sql, QUERY_ROW_LIMIT)).values ?? []
      for (const row of rows) {
        const include = cellText(row, 'INCLUDE')
        if (!include) continue
        const node = normalizeLoadName(include)
        if (!node || node.objectType === 'FUGR') continue // v1 边界：FUGR 不出片段
        candidates.set(node.objectType + ':' + node.objectName, { objectType: node.objectType, objectName: node.objectName })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      unsearched.push({ object: sql.includes('WBCROSSGT') ? 'WBCROSSGT' : 'CROSS', reason: 'cross-reference read failed' })
      void message
    }
  }

  // Step 2：逐候选读源码（读不到/空源码 → unsearched，不计入 totalCallers）
  const callers: CallerSource[] = []
  for (const c of candidates.values()) {
    try {
      const source = await deps.readSource({ objectType: c.objectType, objectName: c.objectName })
      if (!source || !source.trim()) {
        unsearched.push({ object: `${c.objectType} ${c.objectName}`, reason: 'the source came back empty' })
        continue
      }
      callers.push({ objectType: c.objectType, objectName: c.objectName, source })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      unsearched.push({ object: `${c.objectType} ${c.objectName}`, reason: 'source read failed' })
      void message
    }
  }

  // Step 3：片段提取（纯函数）+ 排序 + 截断
  const examples: UsageExample[] = []
  for (const caller of callers) {
    examples.push(...extractCallSites(target, caller))
  }
  examples.sort((a, b) => exampleRank(a) - exampleRank(b)
    || a.callerObjectName.localeCompare(b.callerObjectName)
    || a.lineNumber - b.lineNumber)
  const truncatedExamples = examples.slice(0, maxExamples)

  return {
    target,
    totalCallers: callers.length,
    examples: truncatedExamples,
    unsearched,
    notes
  }
}

/** 处理器注入用的窄客户端接口。 */
export interface UsageExamplesClient {
  getUsageExamples(input: UsageTarget & { maxExamples?: number }): Promise<GetUsageExamplesResult>
}

/** 绑定交叉表 SQL 与源码读取两条既有通道成处理器可注入的窄客户端。 */
export function createUsageExamplesClient(deps: {
  runSql: UsageExamplesSqlRunner
  readSource: UsageExamplesSourceReader
}): UsageExamplesClient {
  return { getUsageExamples: input => getUsageExamples(deps, input) }
}
