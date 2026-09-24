/**
 * D010INC 编译期加载图 API（矩阵行 analysis.history 的 loads 子操作，VSP 来源：
 * pkg/adt/loads.go + pkg/graph/builder_loads.go 语义移植）。
 *
 * D010INC 回答的是"运行它必须加载什么"——与 CROSS/WBCROSSGT 的"代码命名了什么"
 * 是不同的关系：INCLUDE 拆分的依赖在任何交叉引用表都不出现，而类池加载类型池
 * 是运行时强制的依赖、哪怕没有语句命名它。
 *
 * 协议要点（对照 VSP 实现与 7.58 真机样本）：
 * - 两列关键数据 MASTER/INCLUDE 均为填充（padded）形态：
 *     ZCL_VSP_GIT_SERVICE===========CP   ZCL_VSP_GIT_SERVICE===========CM001
 *     SAPLZDEMO_GROUP                    LZDEMO_GROUPTOP
 *     SAPLZDEMO_GROUP                    CL_ABAP_TYPEDESCR=============CT
 *     SAPLZDEMO_GROUP                    <SYSINI>
 * - 三类行里只有"两个不同对象之间的行"是依赖：对象加载自身部件是包含关系
 *   （占绝大多数），<SYSINI>/%_ 开头/~ 开头是内核机器行，全部过滤。
 * - 前缀 LIKE 查询会拖进共享前缀的兄弟对象（ZCL_ORDER 与 ZCL_ORDER_ITEM），
 *   必须按填充规则（名字后跟 = 填充或恰好结束）做归属过滤。
 * - OBSOLETE_IN_VERSION 非 0 的行是历史遗留，丢弃。
 */
import type { TransportHistoryQueryRunner } from './TransportHistoryApi.js'

/** 一条加载关系：master 编译单元加载 include。 */
export interface LoadRow {
  /** 编译单元（程序本体、类池、函数组池）的填充形态原始名。 */
  master: string
  /** 被加载单元的填充形态原始名。 */
  include: string
  /** 非 0 表示该行是旧版本兼容遗留（历史，非当前结构）。 */
  obsoleteInVersion: number
}

/** 归一化后的对象节点（加载图边的一端）。 */
export interface LoadGraphNode {
  objectType: string
  objectName: string
}

/** 一条对象间加载边（LOADS: master → include）。 */
export interface LoadGraphEdge {
  from: LoadGraphNode
  to: LoadGraphNode
  /** 原始 include 形态（填充后缀标明池类型：CT=类类型池、IU/IP=接口池等）。 */
  detail: string
}

/** getLoadGraph 的返回。 */
export interface GetLoadGraphResult {
  objectName: string
  /** loads=该对象拉进什么；loaded_by=什么拉进该对象；both=两个方向都有。 */
  direction: 'loads' | 'loaded_by' | 'both'
  /** 数据源说明（加载 ≠ 引用的语义差异，agent 判读必需）。 */
  source: string
  loads: LoadGraphEdge[]
  loadedBy: LoadGraphEdge[]
  loadsTotal: number
  loadedByTotal: number
  /** 有原始行但全部被过滤（自包含/内核机器行）时的提示。 */
  notes: string[]
}

/** D010INC 单次查询行数上限（VSP loadRowLimit 同值——防内核程序拖全表）。 */
const LOAD_ROW_LIMIT = 2000

/** getLoadGraph 的 SQL 通道输入（复用传输历史 API 的窄通道与行数上限语义）。 */
export type LoadGraphQueryRunner = TransportHistoryQueryRunner

/**
 * 读取编译期加载图（VSP handleLoads 移植）：direction 决定 down（loads）、
 * up（loaded_by）或双向。
 */
export async function getLoadGraph(
  runQuery: LoadGraphQueryRunner,
  input: { objectName: string; direction?: string }
): Promise<GetLoadGraphResult> {
  const capability = 'getLoadGraph'
  const objectName = validateLoadToken(input?.objectName, capability, 'objectName', 40)
  const directionRaw = String(input?.direction ?? 'loads').trim().toLowerCase()
  if (!['loads', 'loaded_by', 'both'].includes(directionRaw)) {
    throw new Error(`${capability}: direction must be "loads", "loaded_by", or "both".`)
  }
  const direction = directionRaw as GetLoadGraphResult['direction']
  const notes: string[] = [
    'source: D010INC, the compile-time load table. These are loads, not calls: what must be present for this to run, which is not the same as what it names.'
  ]

  const loads = direction === 'loaded_by' ? [] : await loadDirection(runQuery, objectName, 'down', notes)
  const loadedBy = direction === 'loads' ? [] : await loadDirection(runQuery, objectName, 'up', notes)

  return {
    objectName,
    direction,
    source: notes[0],
    loads,
    loadedBy,
    loadsTotal: loads.length,
    loadedByTotal: loadedBy.length,
    notes: notes.slice(1)
  }
}

/** 单方向查询：down=MASTER 匹配（该对象拉进什么），up=INCLUDE 匹配（什么拉进它）。 */
async function loadDirection(
  runQuery: LoadGraphQueryRunner,
  objectName: string,
  direction: 'down' | 'up',
  notes: string[]
): Promise<LoadGraphEdge[]> {
  // 一个编译单元在表里的 master 形态：程序=本名、类池=填充名、函数组=SAPL<组>。
  // 一次查询覆盖三种形态，省掉调用方先判断对象类型。
  const sql = direction === 'down'
    ? `SELECT MASTER, INCLUDE, OBSOLETE_IN_VERSION FROM D010INC`
      + ` WHERE MASTER LIKE ${quoteLoadToken(objectName + '%')} OR MASTER = ${quoteLoadToken('SAPL' + objectName)}`
    : `SELECT MASTER, INCLUDE, OBSOLETE_IN_VERSION FROM D010INC`
      + ` WHERE INCLUDE LIKE ${quoteLoadToken(objectName + '%')}`

  let rows: Record<string, unknown>[]
  try {
    rows = (await runQuery(sql, LOAD_ROW_LIMIT)).values ?? []
  } catch (error) {
    // datapreview 通道异常不拖垮主语义：记 notes 返回空（VSP 同款降级）
    notes.push(`D010INC lookup failed and was skipped: ${shortError(error)}`)
    return []
  }

  const edges = new Map<string, LoadGraphEdge>()
  let rowsWithObjectPairs = false
  for (const row of rows) {
    const obsolete = Number(cellLoadText(row, 'OBSOLETE_IN_VERSION') || 0)
    if (obsolete !== 0) continue
    const rawMaster = cellLoadText(row, 'MASTER')
    const rawInclude = cellLoadText(row, 'INCLUDE')
    if (!rawMaster || !rawInclude) continue
    // 内核机器行（<SYSINI>、%_CABAP、~生成的伴随池）两侧都过滤
    if (isGeneratedLoadName(rawMaster) || isGeneratedLoadName(rawInclude)) continue
    // 归属过滤：前缀查询会拖进共享前缀的兄弟对象（ZCL_ORDER vs ZCL_ORDER_ITEM）
    const anchor = direction === 'down' ? rawMaster : rawInclude
    const other = direction === 'down' ? rawInclude : rawMaster
    if (!includeBelongsToName(anchor, objectName)) continue
    const masterNode = normalizeLoadName(rawMaster)
    const includeNode = normalizeLoadName(rawInclude)
    if (!masterNode || !includeNode) continue
    // 对象加载自身部件 = 包含关系（该表绝对多数），不是依赖
    if (masterNode.objectName.toUpperCase() === includeNode.objectName.toUpperCase()) continue
    rowsWithObjectPairs = true
    // 边语义恒为 from（加载者=MASTER 侧）→ to（被加载者=INCLUDE 侧）；
    // up 方向只是筛选锚在 INCLUDE 上，方向不翻转。
    const edge: LoadGraphEdge = {
      from: masterNode,
      to: includeNode,
      detail: `LOADS:${rawInclude}`
    }
    const key = `${edge.from.objectType}:${edge.from.objectName}->${edge.to.objectType}:${edge.to.objectName}`
    if (!edges.has(key)) edges.set(key, edge)
  }
  if (rows.length > 0 && !rowsWithObjectPairs && edges.size === 0) {
    notes.push(
      `${direction === 'down' ? 'loads' : 'loaded_by'}: ${rows.length} D010INC rows matched but all were containment or kernel machinery (no object-to-object dependency).`
    )
  }
  if (rows.length >= LOAD_ROW_LIMIT) {
    notes.push(`D010INC result hit the ${LOAD_ROW_LIMIT}-row cap; narrow the query for a complete picture.`)
  }
  return [...edges.values()]
}

/** 对象名 token 校验（大写 A-Z 0-9 _ /，与传输历史 API 同口径）。 */
function validateLoadToken(value: unknown, capability: string, label: string, max: number): string {
  const token = String(value ?? '').trim().toUpperCase()
  if (!token || token.length > max || !/^[A-Z0-9_/]+$/.test(token)) {
    throw new Error(`${capability}: ${label} "${String(value ?? '')}" is invalid (A-Z 0-9 _ /, at most ${max} characters).`)
  }
  return token
}

/** 单元格容错读取（datapreview 列名大小写差异不敏感）。 */
function cellLoadText(row: Record<string, unknown>, columnName: string): string {
  const key = Object.keys(row).find(k => k.toUpperCase() === columnName.toUpperCase())
  const value = key ? row[key] : undefined
  if (value === undefined || value === null) return ''
  return String(value).trim().toUpperCase()
}

/** SQL 字面量引用（token 已过白名单，引号包裹为纵深防御）。 */
function quoteLoadToken(token: string): string {
  return `'${token.replace(/'/g, "''")}'`
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/**
 * 内核机器行判定（VSP isGenerated 移植）：三种形态都不是可查询的仓库对象——
 * <SYSINI>（内核初始化）、%_CABAP（内核伴随）、~ 前缀（生成的伴随池，如
 * ~CL_XXX===========HCZ，不存在于 REPOSRC/TADIR）。
 */
function isGeneratedLoadName(name: string): boolean {
  return name.startsWith('<') || name.startsWith('%_') || name.startsWith('~')
}

/**
 * 归属判定（VSP includeBelongsToName 移植）：填充形态才是分隔符——
 * ZCL_ORDER 精确、SAPLZCL_ORDER（函数组池）、ZCL_ORDER= 开头（池填充）、
 * L<组> 开头且尾段是函数池段（TOP/UXX/U01…U99/F01…F99/I01/E01/O01）。
 * 其余以名字开头的一律是不同对象（ZCL_ORDER_ITEM 不属于 ZCL_ORDER）。
 */
function includeBelongsToName(include: string, name: string): boolean {
  const inc = include.toUpperCase()
  const target = name.toUpperCase()
  if (inc === target || inc === `SAPL${target}`) return true
  if (inc.startsWith(`${target}=`)) return true
  if (inc.startsWith(`L${target}`)) {
    const rest = inc.slice(1 + target.length)
    return rest !== '' && !rest.startsWith('_') && looksLikePoolSection(rest.slice(-3))
  }
  return false
}

/** 函数池尾段判定（VSP looksLikePoolSection 移植）：TOP/UXX 或 字母+两位数字。 */
function looksLikePoolSection(section: string): boolean {
  if (section === 'TOP' || section === 'UXX') return true
  if (section.length !== 3) return false
  if (section[0] < 'A' || section[0] > 'Z') return false
  for (let i = 1; i < 3; i++) {
    if (section[i] < '0' || section[i] > '9') return false
  }
  return true
}

/**
 * 填充名归一化（VSP NormalizeInclude 移植）：把池形态还原成仓库对象。
 * - NAME====XX（= 填充）：尾段 IP/IU → 接口（INTF），其余（CP/CU/CO/CI/CT/CM*）→ 类（CLAS）
 * - SAPL<组> → 函数组（FUGR）
 * - L<组><段>（尾段是函数池段）→ 函数组（FUGR）
 * - 其余 → 程序（PROG）
 * 无法归一化（空名）返回 undefined。
 */
export function normalizeLoadName(include: string): LoadGraphNode | undefined {
  const inc = include.trim().toUpperCase()
  if (!inc) return undefined
  const padIndex = inc.indexOf('=')
  if (padIndex > 0) {
    const name = inc.slice(0, padIndex).replace(/=+$/, '')
    const suffix = inc.slice(padIndex).replace(/^=+/, '')
    if (!name) return undefined
    if (suffix.startsWith('IP') || suffix.startsWith('IU')) {
      return { objectType: 'INTF', objectName: name }
    }
    return { objectType: 'CLAS', objectName: name }
  }
  if (inc.startsWith('SAPL')) {
    const fugr = inc.slice(4)
    return fugr ? { objectType: 'FUGR', objectName: fugr } : undefined
  }
  if (inc.length > 4 && inc[0] === 'L' && looksLikePoolSection(inc.slice(-3))) {
    const fugr = inc.slice(1, -3)
    return fugr ? { objectType: 'FUGR', objectName: fugr } : undefined
  }
  return { objectType: 'PROG', objectName: inc }
}

/** 处理器注入用的窄客户端接口。 */
export interface LoadGraphClient {
  getLoadGraph(input: { objectName: string; direction?: string }): Promise<GetLoadGraphResult>
}

/** 把 runQuery 通道绑定成处理器可注入的窄客户端（decode 固定 true；不重试）。 */
export function createLoadGraphClient(client: {
  runQuery(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>
}): LoadGraphClient {
  const runner: LoadGraphQueryRunner = async (sql, rowLimit) =>
    (await client.runQuery(sql, rowLimit, true)) ?? { values: [] }
  return {
    getLoadGraph: input => getLoadGraph(runner, input)
  }
}
