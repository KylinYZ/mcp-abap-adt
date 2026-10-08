/**
 * 反向影响面分析 API（矩阵行 analysis.history 的 impact 子操作收编；VSP
 * 来源 internal/mcp/handlers_graph.go handleImpact + fetchReverseDeps 语义移植）。
 *
 * 机制（VSP 同款）：从目标对象出发逐层查询 WBCROSSGT 反向交叉引用
 * （NAME LIKE 'target%'，每层行数有界），INCLUDE 归一化为对象级节点
 * （复用 LoadGraphApi.normalizeLoadName——池名填充/前缀拖进兄弟对象的
 * 归属过滤），BFS 扩展 frontier（maxDepth 3 默认 / 5 上限），输出：
 * 直接调用方、各深度影响集、每边证据（原始 INCLUDE 池名 + 方向）。
 *
 * 边界（如实声明）：
 * - 交叉表只记录激活时引用（编译期）；动态调用（CALL FUNCTION 变量）不在
 *   交叉表中——VSP 语义为 DYNAMIC_CALL 不扩展 frontier，本实现同样不解析。
 * - 归属过滤会排除与目标同名前缀的兄弟对象误命中（normalizeLoadName）。
 * - datapreview 按会话查询预算有限（真机约 19 次）：层数×frontier 是查询
 *   量，maxDepth 与每层行数上限共同控界。
 * - 本实现只做交叉表骨干（WBCROSSGT/CROSS 的 GETSTAT 字段为 'X' 的实际
 *   使用行）；VSP 的 parser 增补与 co-change 增补为可选扩展，不在本轮。
 */
import { normalizeLoadName, includeBelongsToName } from './LoadGraphApi.js'
import type { FmTestDataQueryRunner } from './FmTestDataApi.js'

/** 影响面节点：归一化后的对象身份。 */
export interface ImpactNode {
  type: string
  name: string
}

/** 一条反向引用边（证据级）。 */
export interface ImpactEdge {
  /** 引用方（影响来源）。 */
  from: ImpactNode
  /** 被引用方（目标侧）。 */
  to: ImpactNode
  /** 发现深度（1 = 直接调用方）。 */
  depth: number
  /** 原始 INCLUDE 池名（证据；池名填充形态保留可回查）。 */
  rawInclude: string
}

/** getImpactAnalysis 的返回。 */
export interface ImpactAnalysisResult {
  target: ImpactNode
  /** 直接调用方（depth 1）。 */
  directCallers: ImpactNode[]
  /** 各深度的影响集（depth → 对象清单；不含目标本身）。 */
  levels: Array<{ depth: number; nodes: ImpactNode[] }>
  /** 全部反向引用边（证据）。 */
  edges: ImpactEdge[]
  /** 去重后的影响对象总数（不含目标）。 */
  totalAffected: number
  /** 实际执行的查询轮数（datapreview 预算可见性）。 */
  rounds: number
  notes: string[]
}

/** 影响面默认/上限参数（VSP 同款：默认 3、上限 5）。 */
const DEFAULT_MAX_DEPTH = 3
const MAX_MAX_DEPTH = 5
/** 每层每目标的 WBCROSSGT 查询行数上限（VSP 同款 300）。 */
const ROWS_PER_QUERY = 300
/** 每轮全局查询数上限（datapreview 会话预算防线；预算约 19 次）。 */
const MAX_QUERIES_PER_RUN = 12

/** 目标对象名校验（A-Z 0-9 _ / =，≤40；LIKE 前缀用原样名）。 */
function validateObjectName(value: unknown, capability: string): string {
  const token = String(value ?? '').trim().toUpperCase()
  if (!token || token.length > 40 || !/^[A-Z0-9_/=$]+$/.test(token)) {
    throw new Error(`${capability}: object_name "${String(value ?? '')}" is invalid (A-Z 0-9 _ / = $, at most 40 characters).`)
  }
  return token
}

const OBJECT_TYPES = ['CLAS', 'INTF', 'PROG', 'FUGR', 'FUNC', 'TABL', 'DTEL', 'DOMA', 'MSAG', 'DEVC'] as const

function validateObjectType(value: unknown, capability: string): string {
  const token = String(value ?? '').trim().toUpperCase()
  if (!token || !(OBJECT_TYPES as readonly string[]).includes(token)) {
    throw new Error(`${capability}: object_type "${String(value ?? '')}" is invalid (CLAS, INTF, PROG, FUGR, FUNC, TABL, DTEL, DOMA, MSAG or DEVC).`)
  }
  return token
}

/** 单元格容错读取。 */
function cellText(row: Record<string, unknown>, columnName: string): string {
  const key = Object.keys(row).find(k => k.toUpperCase() === columnName)
  const value = key ? row[key] : undefined
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim() : String(value).trim()
}

/**
 * 反向影响面分析（VSP handleImpact/fetchReverseDeps 骨干移植）：目标 →
 * 逐层 WBCROSSGT（NAME LIKE 'name%'）→ INCLUDE 归一化/归属过滤 → BFS。
 */
export async function getImpactAnalysis(
  runQuery: FmTestDataQueryRunner,
  input: { objectType: string; objectName: string; maxDepth?: number }
): Promise<ImpactAnalysisResult> {
  const capability = 'getImpactAnalysis'
  const target: ImpactNode = {
    type: validateObjectType(input?.objectType, capability),
    name: validateObjectName(input?.objectName, capability)
  }
  const maxDepth = Math.min(Math.max(Number(input?.maxDepth ?? DEFAULT_MAX_DEPTH) || DEFAULT_MAX_DEPTH, 1), MAX_MAX_DEPTH)
  const notes: string[] = [
    'Cross-reference backbone only (WBCROSSGT): records references captured at activation time. Dynamic calls are not resolved (VSP marks them DYNAMIC_CALL without extending the frontier either).'
  ]

  const edges: ImpactEdge[] = []
  const visited = new Set<string>([`${target.type}:${target.name}`])
  const levels: Array<{ depth: number; nodes: ImpactNode[] }> = []
  const directCallers: ImpactNode[] = []
  let rounds = 0

  let frontier: Array<{ node: ImpactNode; rawInclude: string }> = [
    { node: target, rawInclude: '' }
  ]

  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && rounds < MAX_QUERIES_PER_RUN; depth += 1) {
    const nextFrontier: Array<{ node: ImpactNode; rawInclude: string }> = []
    const levelNodes = new Map<string, ImpactNode>()

    for (const front of frontier) {
      if (rounds >= MAX_QUERIES_PER_RUN) break
      rounds += 1
      // 目标名为空安全（validate 已保证非空）
      let rows: Record<string, unknown>[] = []
      try {
        rows = (await runQuery(
          `SELECT include, otype, name FROM wbcrossgt WHERE name LIKE '${front.node.name.replace(/'/g, "''")}%'`,
          ROWS_PER_QUERY
        )).values ?? []
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notes.push(`depth ${depth} query for ${front.node.name} failed and was skipped: ${message.slice(0, 120)}`)
        continue
      }
      for (const row of rows) {
        const rawInclude = cellText(row, 'INCLUDE')
        if (rawInclude === '' || rawInclude.includes(BS)) continue
        const from = normalizeLoadName(rawInclude)
        if (!from || from.objectName === front.node.name) continue // 自引用跳过
        // 归属过滤：INCLUDE 必须真属于 from 对象（前缀拖进兄弟对象排除）
        if (!includeBelongsToName(rawInclude, from.objectName)) continue
        const fromNode: ImpactNode = { type: from.objectType, name: from.objectName }
        edges.push({ from: fromNode, to: front.node, depth, rawInclude })
        const key = `${from.objectType}:${from.objectName}`
        if (!visited.has(key)) {
          visited.add(key)
          const entry: ImpactNode = { type: from.objectType, name: from.objectName }
          levelNodes.set(key, entry)
          if (depth === 1) directCallers.push(entry)
          nextFrontier.push({ node: entry, rawInclude })
        }
      }
    }

    levels.push({ depth, nodes: [...levelNodes.values()] })
    frontier = nextFrontier
  }
  if (frontier.length > 0) {
    notes.push(`Query budget (${MAX_QUERIES_PER_RUN} WBCROSSGT queries) reached before depth ${maxDepth}: deeper levels were not explored. Raise nothing — narrow the target or accept the bounded frontier.`)
  }

  const affected = new Set(edges.map(e => `${e.from.type}:${e.from.name}`))
  return {
    target,
    directCallers,
    levels: levels.filter(l => l.nodes.length > 0),
    edges,
    totalAffected: affected.size,
    rounds,
    notes
  }
}

const BS = String.fromCharCode(92)

/** 处理器注入用的窄客户端接口。 */
export interface ImpactAnalysisClient {
  getImpactAnalysis(input: { objectType: string; objectName: string; maxDepth?: number }): Promise<ImpactAnalysisResult>
}

/** 把 runQuery 通道绑定成窄客户端（decode=true——WBCROSSGT 无 RAW 列，直接解码形态）。 */
export function createImpactAnalysisClient(client: {
  runQuery(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>
}): ImpactAnalysisClient {
  const runner: FmTestDataQueryRunner = async (sql, rowLimit) =>
    (await client.runQuery(sql, rowLimit, true)) ?? { values: [] }
  return {
    getImpactAnalysis: input => getImpactAnalysis(runner, input)
  }
}
