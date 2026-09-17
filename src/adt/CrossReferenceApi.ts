/**
 * ============================================================================
 * CALLEES 交叉引用只读查询 API（补齐能力矩阵 analysis.callgraph 的 down 方向）
 * ============================================================================
 *
 * 回答"这个对象的代码引用了谁"（down 方向，一跳）。数据来源是 SAP 在激活时
 * 回填的两张交叉参考表，而不是 ADT 的 callgraph 端点——VSP vibing-steampunk
 * 在 pkg/adt/callees.go 第 12-24 行已经验证：/sap/bc/adt/cai/callgraph 在
 * 7.50/7.57/7.58 的 discovery 文档中均未出现，带 CSRF token 请求也返回
 * 404 "No suitable resource found"，因此 down 方向改由交叉表自由 SQL 提供。
 *
 * 两张表各管一半、盲区互补（VSP callees.go 第 51-55 行注释）：
 *   - WBCROSSGT：OO 半——类/接口/方法/全局类型/数据（CALL FUNCTION 在这里
 *     查不到）；只报 DIRECT 行，INDIRECT 行是"类型引用噪声"（例如引用 SY
 *     就会连带出现 SYST_DATUM，报出来会让每个类看起来依赖半个 DDIC，
 *     VSP callees.go 第 101-104 行与 415-417 行）。
 *   - CROSS：过程化半——函数模块/报表/SUBMIT/PERFORM/事务（类相关引用在
 *     这里查不到；VSP callees.go 第 133-136 行实测：类对 FM 的调用只出现在
 *     CROSS，完全没有 WBCROSSGT 行）。
 *
 * 设计规则（业务约束）：
 *   - 纯只读：只对交叉表/TFDIR 生成 SELECT，不涉及任何 SAP 写操作。
 *   - SQL 注入防线：对象名在拼入 WHERE 之前必须通过 SAP 命名字符白名单
 *     校验（见 checkRepositoryName 的详细注释），引号/分号/注释符一律拒绝。
 *   - 查询通道是注入的窄接口 RunSql（本文件只生成 SQL 并解析行）；集成时
 *     用 bindRunSqlToAdtQuery 绑定项目 runQuery 的底层 ADT 能力。
 *   - 容错聚合对齐 VSP：两张表独立读取，单表失败不整体失败，返回已得结果
 *     + failedSources（VSP callees.go 第 98-143 行 failures/gaps 语义）；
 *     两表全部失败且无结果时才抛错（第 158-162 行：查询失败和查到空在合并
 *     后不可区分但含义相反，只有"无失败解释的空答案"才允许被报告为空）。
 *   - callers（up 方向）刻意不实现：本项目 usageReferences 已覆盖 where-used
 *     （能力矩阵已计入），避免重复暴露面。
 *   - WBCROSSGTI（未激活版本索引）不查询：那是"激活后会变什么"的另一个
 *     问题，VSP 将其做成独立调用（callees.go 第 189-199 行），合并进普通
 *     答案会描述一段没有任何运行中代码具备的行为。
 */

/** 支持的对象类型：对齐 VSP calleeTargetFromURI 的类型集（callees.go 第 267-285 行）。 */
export type CrossReferenceObjectType = 'PROG' | 'CLAS' | 'INTF' | 'FUGR' | 'FUNC'

/** getCallees 的查询输入：objectType + objectName，maxResults 有界可选。 */
export interface GetCalleesInput {
  /** 对象类型：报表程序/类/接口/函数组/函数模块。 */
  objectType: CrossReferenceObjectType
  /** 对象名，例如 ZCL_FOO；大小写不敏感，内部统一规范为大写。 */
  objectName: string
  /**
   * 返回条数上限：默认 200，硬上限 1000（超出收敛到 1000，不报错——
   * 只读查询无副作用，防御性收敛优于拒绝）。
   */
  maxResults?: number
}

/** 单个 callee：该对象代码引用到的一个东西。 */
export interface Callee {
  /** 被引用对象名（WBCROSSGT 的 NAME 会剥掉 \ME:xxx 组件段，取首段）。 */
  name: string
  /**
   * 引用种类：method / function module / type / data / subroutine / report /
   * transaction / program / dialog module / reference，由表自身的类型码映射
   * （WBCROSSGT.OTYPE 与 CROSS.TYPE，对齐 VSP wbCrossKind 第 519-533 行、
   * crossKind 第 543-562 行）；无法识别的码原样大写透传而不是瞎猜。
   */
  kind: string
  /** 恒为 true：只报 DIRECT 行（本对象的代码亲自命名的引用）。 */
  direct: true
  /**
   * 该引用是一次调用（方法调用/CALL FUNCTION/PERFORM/SUBMIT）还是仅仅
   * 提及（类型/常量引用）。两者都是真实依赖，但只有其一是调用
   * （VSP callees.go 第 47-50 行 Callee.Calls 语义）。
   */
  calls: boolean
  /** 行来源表：两表盲区不同，标明来源才能正确解读缺口。 */
  source: 'WBCROSSGT' | 'CROSS'
  /** 组件名（引用精确到方法/字段时），例如 ZCL_UTILS\ME:DO_STUFF 的 DO_STUFF。 */
  component?: string
}

/** 一次查询中未能覆盖的数据源（单表失败的容错聚合，对齐 VSP Unsearched）。 */
export interface FailedSource {
  /** 未能读取的数据源：WBCROSSGT / CROSS / TFDIR。 */
  source: string
  /** 失败原因摘要（压成单行并截断到 200 字符，避免多行噪声进入结果）。 */
  reason: string
}

/** getCallees 的返回：聚合后的 callee 清单 + 覆盖度说明。 */
export interface GetCalleesResult {
  /** 规范化（大写）后的查询对象名。 */
  objectName: string
  /** 规范化后的对象类型。 */
  objectType: CrossReferenceObjectType
  /** 实际拼入 WHERE 的 include 谓词（透出以便核对匹配范围）。 */
  includePredicate: string
  /** 聚合排序后的 callee 清单（calls 优先，其次按名称升序）。 */
  callees: Callee[]
  /** 截断标注：合并去重后的清单超过 maxResults 被截断时为 true。 */
  truncated: boolean
  /** 读取成功的数据源清单（调用方可用它与 failedSources 核对覆盖度）。 */
  sourcesSearched: string[]
  /** 单表失败聚合：空的 failedSources 表示两表都读到了。 */
  failedSources: FailedSource[]
}

/** 单行查询结果：列名 -> 单元格值（数值/字符串混合，读取处统一容错转字符串）。 */
export type CrossReferenceRow = Record<string, unknown>

/**
 * 注入的查询窄接口：本文件只负责"生成 SQL + 解析行"，执行通道由集成方注入。
 * 集成绑定方式见 bindRunSqlToAdtQuery（底层即项目 runQuery 走的
 * /sap/bc/adt/datapreview/freestyle ADT 数据预览通道）。
 */
export type RunSql = (sql: string) => Promise<readonly CrossReferenceRow[]>

/** maxResults 默认值（产品口径：单次返回 200 条足够一跳引用分析阅读）。 */
export const DEFAULT_MAX_RESULTS = 200

/** maxResults 硬上限（对齐"有界输出"约束，防止单查询拖回海量行）。 */
export const MAX_RESULTS_CAP = 1000

/**
 * 单表行数上限默认值：对齐 VSP calleeRowLimit = 500（callees.go 第 237-247 行：
 * 防止对内核 include 的一次查询拖回数千行；超出说明没人会读完这份清单）。
 * 该值只作为 bindRunSqlToAdtQuery 的默认绑定行数，逐次 maxResults 截断在
 * 聚合后由本文件自行执行。
 */
export const CALLEE_ROW_LIMIT = 500

/* ==========================================================================
 * 对象名规范化与 SQL 注入防线
 * ========================================================================== */

/**
 * SAP 仓库名称字符白名单：大写字母、数字、下划线、命名空间斜杠 /、美元 $。
 *
 * 【这是 SQL 注入防线——所有名字拼进 WHERE 字面量之前的唯一闸门】
 * 来源与取舍（VSP callees.go 第 384-402 行 checkSQLLiteral）：
 *   - 名字会被直接拼进 `INCLUDE LIKE '<name>%'` 这类单引号字面量，而查询
 *     通道（datapreview freestyle）执行的是自由 SQL：一个单引号就能结束
 *     字面量，其后的内容会被当作 SQL 执行。因此引号（'、"）、语句分隔符
 *     （;）、注释符（--、/*、#）以及空格/括号等一切 SQL 元字符都必须在
 *     拼接前被白名单整体拒绝，而不是事后转义。
 *   - 白名单按"字符类"而非"黑名单"工作：拒绝列表永远追不完注入花样，
 *     只有 A-Z 0-9 _ / $ 之外的全部拒绝才能保证字面量不可逃逸。
 *   - '/' 是 SAP 命名空间前缀字符（如 /SDF/GET_APP_LOG，VSP 第 396 行同样
 *     放行）；'$' 出现在临时/生成对象名中（任务规格要求放行）。两者都无法
 *     与其余白名单字符组合出任何 SQL 元字符，放行不构成注入面。
 *   - 与 VSP 的差异：VSP 还放行 '='，因为它接受的是已按 '=' 填充过的
 *     include 名；本 API 的输入是对象名（不含 '='），无需放行，进一步收窄。
 *
 * @returns 规范化（trim + 大写）后的对象名
 * @throws 名字为空、超长（>40，WBCROSSGT-INCLUDE 为 CHAR(40) 的容量上限）
 *         或含白名单之外字符时抛错——含空格的样本（如 "Z X'--"）、含分号的
 *         样本（如 "Z;DROP"）都会在此被拦截，SQL 永远不会生成。
 */
export function normalizeRepositoryName(value: unknown, capability: string): string {
  const name = String(value ?? '').trim().toUpperCase()
  if (!name || name.length > 40 || !/^[A-Z0-9_/$]+$/.test(name)) {
    throw new Error(
      `${capability}: "${String(value ?? '')}" is not a repository name ` +
      `(allowed: A-Z 0-9 _ / $, at most 40 characters), so it is not put into a query.`
    )
  }
  return name
}

/** 把行内单元格容错地读成字符串：null/undefined 记空串，其余 trim 后字符串化。 */
function rowString(row: CrossReferenceRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** 失败原因摘要：压成单行并截断到 200 字符（容错聚合只描述缺口，不搬运日志）。 */
function summarizeReason(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()
  return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw
}

/* ==========================================================================
 * include 谓词构造（对齐 VSP includePredicate，callees.go 第 314-335 行）
 * ========================================================================== */

// 三个 SQL 模板逐字对齐 VSP callees.go 第 106-107、136-137、352 行；
// WHERE 之后的谓词由本文件构造，且对象名已过 normalizeRepositoryName 白名单。
const WBCROSSGT_SQL_PREFIX = 'SELECT INCLUDE, OTYPE, NAME, DIRECT FROM WBCROSSGT WHERE '
const CROSS_SQL_PREFIX = 'SELECT INCLUDE, TYPE, NAME, PROG FROM CROSS WHERE '
const TFDIR_SQL_PREFIX = 'SELECT PNAME, INCLUDE FROM TFDIR WHERE FUNCNAME = '

/**
 * 把 objectType + objectName 规范化为"该对象自己的 include"谓词。
 * 交叉表按 include 而不是按对象键行（VSP callees.go 第 27-28 行），各类对象
 * 的 include 形态（VSP 第 305-335 行注释）：
 *   - CLAS/INTF：include = 名称 + 若干 '=' 填充 + 段后缀（ZCL_FOO=====CM001、
 *     =====CI、=====CU），LIKE '<名称>%' 一次捞全，越界的兄弟对象行由
 *     includeBelongsToTarget 二次过滤；
 *   - PROG：程序自身就是 include，精确等值；
 *   - FUGR：函数组 include 形如 L<组名>TOP / L<组名>U01，LIKE 'L<组名>%';
 *   - FUNC：函数模块体只在一个 include 里，编号只有 TFDIR 知道，需先查
 *     TFDIR（见 functionModuleInclude）。
 *
 * @throws FUNC 的 TFDIR 解析失败/查不到时抛错（对齐 VSP：谓词构造失败是
 *         硬错误，发生在两表查询之前，不会进入 failedSources 容错）。
 */
async function buildIncludePredicate(
  runSql: RunSql,
  objectType: CrossReferenceObjectType,
  objectName: string
): Promise<string> {
  switch (objectType) {
    case 'CLAS':
    case 'INTF':
      // VSP callees.go 第 322 行：INCLUDE LIKE '<名称>%'
      return `INCLUDE LIKE '${objectName}%'`
    case 'PROG':
      // VSP callees.go 第 323-324 行：程序是自己的 include
      return `INCLUDE = '${objectName}'`
    case 'FUGR':
      // VSP callees.go 第 326 行：函数组 include 一律 L<组名> 开头
      return `INCLUDE LIKE 'L${objectName}%'`
    case 'FUNC': {
      // VSP callees.go 第 327-333 行：函数模块 → TFDIR 往返 → 精确 include
      const include = await functionModuleInclude(runSql, objectName)
      return `INCLUDE = '${include}'`
    }
  }
}

/**
 * 解析函数模块到承载其函数体的唯一 include（VSP functionModuleInclude，
 * callees.go 第 346-370 行）。
 *
 * 必须做这次往返：函数组的 include 是组内每个模块的并集，用组谓词回答
 * "这个模块引用了谁"是另一个问题、一份糟得多的答案（VSP 第 337-345 行）。
 * TFDIR 用 PNAME 存主程序（SAPL<组名>）、INCLUDE 存节号，L<组名>U<两位节号>
 * 就是交叉表键的 include（VSP 实测：BAL_LOG_CREATE → SAPLSBAL 节 15 →
 * LSBALU15）。
 */
async function functionModuleInclude(runSql: RunSql, objectName: string): Promise<string> {
  let rows: readonly CrossReferenceRow[]
  try {
    rows = await runSql(`${TFDIR_SQL_PREFIX}'${objectName}'`)
  } catch (error) {
    throw new Error(`asking TFDIR which include holds ${objectName}: ${summarizeReason(error)}`)
  }
  if (!rows || rows.length === 0) {
    throw new Error(`function module ${objectName} is not in TFDIR, so the include holding its body is unknown`)
  }
  // PNAME 形如 SAPL<组名>；剥掉 SAPL 前缀得到组名
  const pool = rowString(rows[0], 'PNAME').toUpperCase()
  const section = rowString(rows[0], 'INCLUDE')
  const group = pool.startsWith('SAPL') ? pool.slice('SAPL'.length) : pool
  if (!group || !section) {
    throw new Error(`TFDIR names no group or no section for ${objectName}`)
  }
  // 节号补齐两位（VSP poolIncludeFor，callees.go 第 375-382 行）：TFDIR 存数字，
  // include 要两位——LZGRP_U5 与 LZGRPU05 完全不是一回事
  const include = `L${group}U${section.padStart(2, '0')}`
  // 纵深防御：include 由 DB 数据拼装而非调用方输入，拼进 SQL 前仍过一遍白名单
  return normalizeRepositoryName(include, 'functionModuleInclude')
}

/**
 * include 归属过滤（近似 VSP includeBelongsTo，callees.go 第 474-492 行）。
 * LIKE '<名称>%' 会捞到 ZCL_FOO_HELPER 这类共享前缀兄弟对象的行，"被引用
 * 清单里悄悄混进别的类的依赖"比清单短更糟，所以逐行二次确认归属。
 *
 * 与 VSP 的差异：VSP 用 unitForFrame（dumpimpact.go）把 include 精确映射回
 * 所属对象；本项目没有该设施，按 include 命名规则近似：
 *   - PROG/FUNC：谓词本身是精确等值，无需甄别（对齐 VSP 第 479-483 行）；
 *   - CLAS/INTF：include 等于名称本身，或以 "<名称>=" 开头（'=' 填充段）；
 *     名称满 30 字符时填充段为空、include 直接以名称接后缀（如
 *     <名称30>CM001），此时退化为前缀匹配——极端命名长度的已知近似。
 *   - FUGR：include 形如 L<组名>TOP 或 L<组名><单字母><两位数字>
 *     （U01 模块体/F01 FORM/I01/O01/T01...），逐字符比对可排除
 *     LZGRP2TOP 冒充 LZGRP 的前缀碰撞。
 */
function includeBelongsToTarget(
  include: string,
  objectType: CrossReferenceObjectType,
  objectName: string
): boolean {
  const inc = include.trim().toUpperCase()
  if (!inc) return false
  switch (objectType) {
    case 'PROG':
    case 'FUNC':
      return true
    case 'CLAS':
    case 'INTF':
      return (
        inc === objectName
        || inc.startsWith(`${objectName}=`)
        || (objectName.length === 30 && inc.startsWith(objectName))
      )
    case 'FUGR': {
      const prefix = `L${objectName}`
      if (!inc.startsWith(prefix)) return false
      const rest = inc.slice(prefix.length)
      return rest === 'TOP' || /^[A-Z]\d{2}$/.test(rest)
    }
  }
}

/* ==========================================================================
 * 类型码 → kind 映射（逐字对齐 VSP wbCrossKind / crossKind）
 * ========================================================================== */

/**
 * WBCROSSGT.OTYPE（OO 半类型码）→ kind（VSP callees.go 第 519-533 行）。
 * 只有 ME（方法调用）算调用；TY/DA 是类型与数据提及；空码报 reference；
 * 未知码大写透传而不是瞎猜（VSP 第 40-42 行注释）。
 */
function wbCrossKind(otype: string): { kind: string; calls: boolean } {
  const code = otype.trim().toUpperCase()
  switch (code) {
    case 'ME': return { kind: 'method', calls: true }
    case 'TY': return { kind: 'type', calls: false }
    case 'DA': return { kind: 'data', calls: false }
    case '': return { kind: 'reference', calls: false }
    default: return { kind: code, calls: false }
  }
}

/**
 * CROSS.TYPE（过程化半类型码，单字符 C(1)）→ kind（VSP callees.go 第 543-574 行）。
 * 常量取值必须逐字符：代码史上曾把 'FU' 当双字符码写下，结果被数据预览资源
 * 以 400 "'FU' is not a valid value for C(1,0)" 拒绝、错误又被吞成"没有调用者"
 * （VSP 第 536-542 行教训）。五个码都是调用；空码报 reference。
 */
function crossKind(type: string): { kind: string; calls: boolean } {
  const code = type.trim().toUpperCase()
  switch (code) {
    case 'F': return { kind: 'function module', calls: true } // CALL FUNCTION
    case 'R': return { kind: 'report', calls: true }          // SUBMIT
    case 'T': return { kind: 'transaction', calls: true }     // CALL TRANSACTION
    case 'U': return { kind: 'subroutine', calls: true }      // PERFORM；PROG 列持有 form 所属程序
    case 'P': return { kind: 'program', calls: true }
    case 'D': return { kind: 'dialog module', calls: true }
    case '': return { kind: 'reference', calls: false }
    default: return { kind: code, calls: false }
  }
}

/**
 * 剥出 WBCROSSGT.NAME 里的对象名与组件名（VSP splitCrossName，callees.go 第 494-517 行）。
 * NAME 形如 "ZCL_UTILS\ME:DO_STUFF"（对象 + 反斜杠 + 两字母标签 + 冒号 +
 * 组件），也可能带更深嵌套（"\DA:IV_DATA"——你调用的方法的参数不是你调用的
 * 另一个东西），只保留第一个组件段。
 */
function splitCrossName(raw: string): { name: string; component: string } {
  const upper = raw.trim().toUpperCase()
  if (!upper) return { name: '', component: '' }
  const parts = upper.split('\\')
  const name = parts[0].trim()
  let component = ''
  if (parts.length > 1) {
    component = parts[1].trim()
    // 组件段形如 "ME:DO_STUFF"：标签说明组件种类（kind 已携带），要的是名字
    const colon = component.indexOf(':')
    if (colon >= 0) component = component.slice(colon + 1)
  }
  return { name, component }
}

/* ==========================================================================
 * 行解析（对齐 VSP wbCrossCallees 第 405-434 行 / crossCallees 第 437-468 行）
 * ========================================================================== */

/** WBCROSSGT 行 → callee 列表：只留 DIRECT 行，跳过自引用与空名。 */
function wbCrossCallees(
  rows: readonly CrossReferenceRow[],
  objectType: CrossReferenceObjectType,
  objectName: string
): Callee[] {
  const out: Callee[] = []
  for (const row of rows) {
    if (!includeBelongsToTarget(rowString(row, 'INCLUDE'), objectType, objectName)) continue
    // DIRECT 列为 'X' 才是本对象亲自命名的引用；INDIRECT 是类型引用噪声
    if (rowString(row, 'DIRECT').toUpperCase() !== 'X') continue
    const { name, component } = splitCrossName(rowString(row, 'NAME'))
    if (!name || name === objectName) {
      // 类引用自己的属性/方法不算 callee——每个类的每个方法都在这么做
      continue
    }
    const { kind, calls } = wbCrossKind(rowString(row, 'OTYPE'))
    out.push({
      name,
      kind,
      direct: true,
      calls,
      source: 'WBCROSSGT',
      ...(component ? { component } : {})
    })
  }
  return out
}

/** CROSS 行 → callee 列表：处理 PERFORM 的 NAME/PROG 交换，跳过自引用与空名。 */
function crossCallees(
  rows: readonly CrossReferenceRow[],
  objectType: CrossReferenceObjectType,
  objectName: string
): Callee[] {
  const out: Callee[] = []
  for (const row of rows) {
    if (!includeBelongsToTarget(rowString(row, 'INCLUDE'), objectType, objectName)) continue
    let name = rowString(row, 'NAME').toUpperCase()
    if (!name) continue
    const { kind, calls } = crossKind(rowString(row, 'TYPE'))
    let component = ''
    // PERFORM 行：NAME 是子例程名、PROG 是例程所属程序（VSP callees.go 第 449-455 行）。
    // 程序才是有人能打开的对象，form 只是它的哪个部分，所以两者交换：
    // name=PROG（对象），component=NAME（form 名）。
    const prog = rowString(row, 'PROG').toUpperCase()
    if (prog) {
      component = name
      name = prog
    }
    if (name === objectName) continue
    out.push({
      name,
      kind,
      direct: true,
      calls,
      source: 'CROSS',
      ...(component ? { component } : {})
    })
  }
  return out
}

/**
 * 合并去重（对齐 VSP mergeCallees，callees.go 第 583-617 行）。
 * 同一对象会被引用很多次——调用一个类的三个方法是三行，加上类型行是四行——
 * 但对象才是任何人能采取行动的单位。调用优先于类型提及：当两者都在时，
 * "它是个我提到的类型"在"我调用了它的方法"为真时恒真，后者才值得报告；
 * 组件名用逗号串联合并。排序：calls 优先，其次名称升序——开头四十个 DDIC
 * 类型会把调用埋掉。
 */
function mergeCallees(inRows: readonly Callee[]): Callee[] {
  const byName = new Map<string, Callee>()
  const out: Callee[] = []
  for (const callee of inRows) {
    const existing = byName.get(callee.name)
    if (!existing) {
      out.push(callee)
      byName.set(callee.name, callee)
      continue
    }
    // 调用行升级覆盖类型提及行（kind/calls/source 一并换成调用侧的值）
    if (callee.calls && !existing.calls) {
      existing.kind = callee.kind
      existing.calls = true
      existing.source = callee.source
    }
    // 组件名合并：已包含则跳过，避免同名组件重复罗列
    if (callee.component && !(existing.component || '').includes(callee.component)) {
      existing.component = existing.component
        ? `${existing.component}, ${callee.component}`
        : callee.component
    }
  }
  // 稳定排序：calls 优先，其次名称升序（对齐 VSP callees.go 第 608-615 行）
  out.sort((a, b) => {
    if (a.calls !== b.calls) return a.calls ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return out
}

/* ==========================================================================
 * 主入口：getCallees（对齐 VSP Callees，callees.go 第 87-165 行）
 * ========================================================================== */

/**
 * 查询"给定对象的代码引用了谁"（down 方向，一跳）。
 *
 * 深度恒为一跳：交叉表按 include 键行，走第二跳意味着每个子对象再发一轮
 * 查询——几十次往返——换一份越宽越没用的答案（VSP callees.go 第 75-80 行）。
 * 两表独立读取：单表失败时返回另一表的结果 + failedSources（CROSS 是
 * CALL FUNCTION 唯一的出处，把"读不到 CROSS"说成"没有 FM 调用"是最危险的
 * 半份答案，所以缺口必须随行返回）；两表都失败且无结果时抛错——查询失败
 * 与查到空合并后不可区分但含义相反，只允许"无失败解释的空答案"被报告为空
 * （VSP callees.go 第 145-162 行）。
 *
 * @param runSql 注入的 SQL 查询通道（见 RunSql / bindRunSqlToAdtQuery）
 * @param input  objectType + objectName + 可选 maxResults
 */
export async function getCallees(runSql: RunSql, input: GetCalleesInput): Promise<GetCalleesResult> {
  // 1) 名字规范化 + 白名单校验：任何注入样本在此被拒绝，SQL 永远不会生成
  const capability = 'getCallees'
  if (!input || typeof input !== 'object') {
    throw new Error(`${capability}: input object is required.`)
  }
  // objectType 大小写不敏感（对齐 handler 层规范化语义）
  const rawObjectType = String(input.objectType ?? '').trim().toUpperCase() as CrossReferenceObjectType
  if (rawObjectType !== 'PROG' && rawObjectType !== 'CLAS' && rawObjectType !== 'INTF'
    && rawObjectType !== 'FUGR' && rawObjectType !== 'FUNC') {
    throw new Error(`${capability}: objectType must be one of PROG, CLAS, INTF, FUGR, FUNC.`)
  }
  const objectName = normalizeRepositoryName(input.objectName, capability)

  // 2) maxResults 有界化：默认 200，硬上限 1000；非法值（NaN/<1）收敛到默认/1
  const requested = Number(input.maxResults ?? DEFAULT_MAX_RESULTS)
  const maxResults = Math.min(
    Math.max(Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_MAX_RESULTS, 1),
    MAX_RESULTS_CAP
  )

  // 3) 构造 include 谓词（FUNC 在此做 TFDIR 往返；失败为硬错误）
  const includePredicate = await buildIncludePredicate(runSql, rawObjectType, objectName)

  // 4) 两表独立读取，单表失败进入 failedSources 而不中断聚合
  const failedSources: FailedSource[] = []
  const sourcesSearched: string[] = []
  let wbRows: readonly CrossReferenceRow[] | undefined
  let crossRows: readonly CrossReferenceRow[] | undefined

  // WBCROSSGT：OO 半（VSP callees.go 第 106-107 行 SQL 逐字对齐）
  try {
    wbRows = await runSql(`${WBCROSSGT_SQL_PREFIX}${includePredicate}`)
    sourcesSearched.push('WBCROSSGT')
  } catch (error) {
    failedSources.push({ source: 'WBCROSSGT', reason: summarizeReason(error) })
  }

  // CROSS：过程化半（VSP callees.go 第 136-137 行 SQL 逐字对齐）
  try {
    crossRows = await runSql(`${CROSS_SQL_PREFIX}${includePredicate}`)
    sourcesSearched.push('CROSS')
  } catch (error) {
    failedSources.push({ source: 'CROSS', reason: summarizeReason(error) })
  }

  // 两表全部失败且无结果：不能把"查不了"报告成"没有引用"（VSP 第 158-162 行）
  if (!wbRows && !crossRows) {
    throw new Error(
      `the cross-reference tables could not be read for ${objectName} ` +
      `(${failedSources.map(f => `${f.source}: ${f.reason}`).join('; ')}); ` +
      'callees are read from CROSS and WBCROSSGT over free SQL, so this answers nothing ' +
      'if free SQL is blocked or the user may not read those tables'
    )
  }

  // 5) 行解析 + 合并去重 + 排序 + 有界截断
  const merged = mergeCallees([
    ...(wbRows ? wbCrossCallees(wbRows, rawObjectType, objectName) : []),
    ...(crossRows ? crossCallees(crossRows, rawObjectType, objectName) : [])
  ])
  const truncated = merged.length > maxResults

  return {
    objectName,
    objectType: rawObjectType,
    includePredicate,
    callees: truncated ? merged.slice(0, maxResults) : merged,
    truncated,
    sourcesSearched,
    failedSources
  }
}

/* ==========================================================================
 * 客户端绑定（供后续集成任务接线的注入点，本任务不改动任何现有文件）
 * ========================================================================== */

/**
 * 项目底层自由 SQL 能力的最小结构视图（duck typing，不 import AdtClient，
 * 避免制造接线耦合）：与 src/adt/api/tablecontents.ts 的 runQuery 及
 * AdtClient.runQuery(sqlQuery, rowNumber, decode) 的公开签名对齐，返回
 * { columns, values }，其中 values 是"列名 -> 值"的行对象数组。
 */
export interface AdtFreestyleQueryCapability {
  runQuery(
    sqlQuery: string,
    rowNumber?: number,
    decode?: boolean
  ): Promise<{ values?: CrossReferenceRow[] }>
}

/**
 * 把项目 runQuery 底层能力绑定成 RunSql 查询通道。
 *
 * 集成任务接线指引（无需改动 AdtClient/QueryHandlers）：
 *   const runSql = bindRunSqlToAdtQuery(client, CALLEE_ROW_LIMIT)
 *   const handlers = new CrossReferenceHandlers(createCrossReferenceClient(runSql))
 * 其中 client 是 AdtClient 实例（其公开 runQuery 走
 * POST /sap/bc/adt/datapreview/freestyle）。rowNumber 决定单表行数上限，
 * 建议绑定 CALLEE_ROW_LIMIT(500，对齐 VSP calleeRowLimit)；decode 必须为
 * true，否则数值/编码列不会解码，DIRECT='X' 之类的判断会失真。
 */
export function bindRunSqlToAdtQuery(
  client: AdtFreestyleQueryCapability,
  rowLimit: number = CALLEE_ROW_LIMIT
): RunSql {
  return async sql => {
    const result = await client.runQuery(sql, rowLimit, true)
    return result?.values ?? []
  }
}

/** 处理器注入用的窄客户端接口（风格对齐 CdsAnalysisClient）。 */
export interface CrossReferenceClient {
  getCallees(input: GetCalleesInput): Promise<GetCalleesResult>
}

/** 把 RunSql 通道绑定成处理器可注入的窄客户端。 */
export function createCrossReferenceClient(runSql: RunSql): CrossReferenceClient {
  return {
    getCallees: input => getCallees(runSql, input)
  }
}
