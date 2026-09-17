import type { AdtHTTP } from './AdtHTTP'
import {
  encodeEntity,
  fullParse,
  xmlArray,
  xmlFlatArray,
  xmlNodeAttr,
  xmlRoot
} from './utilities'

/**
 * ============================================================================
 * 单元测试行级覆盖率 ADT API（执行型，关闭能力矩阵缺口 read.coverage）
 * ============================================================================
 *
 * 对齐 VSP vibing-steampunk 的 focused GetCodeCoverage 能力（运行单元测试并
 * 读取行级覆盖率）：
 *   - VSP 客户端实现：pkg/adt/testing.go 的 GetCodeCoverage / parseCoverageResult
 *   - VSP 工具入口：internal/mcp/handlers_testing.go handleGetCodeCoverage、
 *     internal/mcp/tools_register.go GetCodeCoverage 注册项、
 *     internal/mcp/tools_focused.go 第 133 行 focused 白名单
 *
 * ADT 端点（VSP testing.go 第 69 行，与本项目 runUnitTest 同端点）：
 *   POST /sap/bc/adt/abapunit/testruns
 *   Content-Type: application/*   Accept: application/*
 *   请求体 aunit:runConfiguration 的 <external><coverage active="true"/></external>
 *   打开覆盖率采集（本项目既有 runUnitTest 为 active="false"，仅不采覆盖率）。
 *
 * 语义标注（重要，业务规则）：
 *   - 本能力是执行行为，与 unitTestRun 同级，绝非只读：对象零修改，但会在
 *     SAP 系统上执行被测对象的用户代码，消耗系统资源（CPU/时间），并可能触发
 *     被测代码自身的副作用。接入 profile 时必须按执行/变更类（other-mutation）
 *     门控，不得标成 read-only。
 *   - 输入只接受 objectType+objectName；测试对象的 ADT URI 一律由对象名在
 *     服务端推导，绝不接受调用方传入的任意 URL（本项目安全边界）。
 *   - 解析层容错对齐 VSP parseCoverageResult：覆盖率数据结构不符合预期时返回
 *     零值/空结果而非抛错（端点可能不返回 coverage 段，例如系统未启用覆盖率
 *     采集）；只有 HTTP 层错误才向上传播，且原样传播不包装。
 *   - 裁剪输出：仅返回精简 JSON（对象名/执行状态/覆盖率数字），绝不向调用方
 *     返回原始 XML 响应体。
 */

/** 支持的测试对象类型：报表 / 类 / 函数模块（对齐 VSP GetCodeCoverage 用法）。 */
export type UnitCoverageObjectType = 'PROGRAM' | 'CLASS' | 'FUNCTION_MODULE'

/** 风险档位枚举（对齐 VSP UnitTestRunFlags 的 Harmless/Dangerous/Critical）。 */
export type UnitCoverageRiskLevel = 'HARMLESS' | 'DANGEROUS' | 'CRITICAL'

/** 时长档位枚举（对齐 VSP UnitTestRunFlags 的 Short/Medium/Long）。 */
export type UnitCoverageDuration = 'SHORT' | 'MEDIUM' | 'LONG'

/** runUnitCoverage 的输入：对象定位 + 可选测试筛选档位。 */
export interface UnitCoverageQuery {
  /** 测试对象类型，必填；FUNCTION_MODULE 的 objectName 需用 GROUP/FUNC 复合格式。 */
  objectType: UnitCoverageObjectType
  /**
   * 测试对象名，必填；内部统一规范为大写。
   * PROGRAM/CLASS 为单一对象名（如 ZCL_COVERAGE_DEMO）；
   * FUNCTION_MODULE 为复合格式 FUNCTION_GROUP/FUNCTION_MODULE（如 ZFG_COV/ZFM_COV），
   * 因为函数模块的 ADT URI 必须由所属函数组推导（见 deriveUnitTestObjectUri）。
   */
  objectName: string
  /**
   * 风险档位（累计语义：包含该档位及更低档位的测试）：
   *   HARMLESS  → 仅 harmless（VSP 默认）
   *   DANGEROUS → harmless + dangerous
   *   CRITICAL  → harmless + dangerous + critical
   * 缺省 = HARMLESS（对齐 VSP DefaultUnitTestFlags 的 Harmless:true,其余 false）。
   */
  riskLevel?: UnitCoverageRiskLevel
  /**
   * 时长档位（累计语义：包含该档位及更低时长的测试）：
   *   SHORT  → 仅 short
   *   MEDIUM → short + medium
   *   LONG   → short + medium + long
   * 缺省 = MEDIUM 等效标志集，即 short+medium（逐字对齐 VSP DefaultUnitTestFlags：
   * Short:true, Medium:true, Long:false——注意本项目既有 DefaultUnitTestRunFlags
   * 为 short-only，此处按任务要求以 VSP 默认为准）。
   */
  duration?: UnitCoverageDuration
}

/** 单项覆盖率统计（字段命名对齐 VSP CoverageStats：total/covered/percent）。 */
export interface UnitCoverageStats {
  /** 该维度语句/分支/过程总数。 */
  total: number
  /** 被测试覆盖到的数量。 */
  covered: number
  /** 覆盖率百分比 = covered/total*100，保留 2 位小数；total=0 时为 0。 */
  percent: number
}

/** 单个源对象（主程序/类）的语句级覆盖率（字段对齐 VSP SourceCoverage）。 */
export interface UnitCoverageSourceEntry {
  /** 源对象的 ADT URI（SAP 返回，非调用方输入）。 */
  uri: string
  /** 源对象的 ADT 技术类型（如 PROG/P、CLAS/OC；SAP 未返回时省略）。 */
  type?: string
  /** 源对象名（SAP 未返回时省略）。 */
  name?: string
  /** 该源的语句级覆盖统计。 */
  statements: UnitCoverageStats
}

/** 单个测试方法的执行结果（裁剪：名字/耗时/告警计数/状态）。 */
export interface UnitCoverageMethodResult {
  /** 测试方法名。 */
  name: string
  /** 执行耗时（毫秒，SAP 属性 executionTime；未返回时省略）。 */
  executionTime?: number
  /** 该方法产生的告警（断言失败/异常/警告）数量。 */
  alertCount: number
  /** 执行状态：passed=无告警；alerts=存在告警（细节请用 unitTestRun/评估工具）。 */
  status: 'passed' | 'alerts'
}

/** 单个测试类的执行结果（裁剪）。 */
export interface UnitCoverageClassResult {
  /** 测试类名。 */
  name: string
  /** 测试类的 ADT 技术类型（如 CLAS/XT；SAP 未返回时省略）。 */
  type?: string
  /** 测试类声明的风险档位（SAP 未返回时省略）。 */
  riskLevel?: string
  /** 测试类声明的时长档位（SAP 未返回时省略）。 */
  durationCategory?: string
  /** 类级 + 方法级告警总数。 */
  alertCount: number
  /** 执行状态：passed=无任何告警；alerts=存在告警。 */
  status: 'passed' | 'alerts'
  /** 测试方法结果清单（无方法时为空数组）。 */
  testMethods: UnitCoverageMethodResult[]
}

/** runUnitCoverage 的返回：执行结果 + 覆盖率度量的精简 JSON。 */
export interface UnitCoverageResult {
  /** 规范化（大写）后的查询对象名（FUNCTION_MODULE 为 GROUP/FUNC 复合形式）。 */
  objectName: string
  /** 回显对象类型，便于调用方核对。 */
  objectType: UnitCoverageObjectType
  /** 本次请求实际使用的测试对象 ADT URI（服务端从对象名推导）。 */
  objectUri: string
  /**
   * 实际生效的测试筛选标志（riskLevel/duration 累计展开后的六布尔集，
   * 与请求 XML 中 testRiskLevels/testDurations 属性一一对应），回显以便
   * 调用方核对测试范围，避免"以为只跑了 short 实际跑了 medium"的误读。
   */
  flags: {
    harmless: boolean
    dangerous: boolean
    critical: boolean
    short: boolean
    medium: boolean
    long: boolean
  }
  /** 测试执行结果（每测试类）与汇总计数。 */
  execution: {
    /** 每个测试类的执行状态（SAP 未返回测试类时为空数组）。 */
    testClasses: UnitCoverageClassResult[]
    /** 汇总：测试类数 / 测试方法数 / 告警总数。 */
    summary: { testClassCount: number; testMethodCount: number; alertCount: number }
  }
  /** 覆盖率度量（字段对齐 VSP CoverageResult：statements/branches/procedures/sourceCoverage）。 */
  coverage: {
    /** 语句级覆盖（VSP Statements）。 */
    statements: UnitCoverageStats
    /** 分支级覆盖（VSP Branches；响应无 branch 段时为全 0）。 */
    branches: UnitCoverageStats
    /** 过程级覆盖（VSP Procedures；响应无 procedure 段时为全 0）。 */
    procedures: UnitCoverageStats
    /**
     * 按源对象 URI 索引的语句级覆盖（VSP SourceCoverage 为 map[uri]*SourceCoverage，
     * 这里保持同一键控结构）；响应未带 uri 属性的 node 不计入。
     */
    sourceCoverage: Record<string, UnitCoverageSourceEntry>
  }
}

/** 六布尔测试筛选标志集（对齐本项目 UnitTestRunFlags / VSP UnitTestRunFlags）。 */
export interface UnitCoverageFlags {
  harmless: boolean
  dangerous: boolean
  critical: boolean
  short: boolean
  medium: boolean
  long: boolean
}

/**
 * 将 riskLevel/duration 档位展开为六布尔标志集（累计语义）。
 * 双双缺省时的结果与 VSP devtools.go DefaultUnitTestFlags 逐字段一致：
 * Harmless:true, Dangerous:false, Critical:false, Short:true, Medium:true, Long:false。
 * 导出供处理器层测试默认值契约。
 */
export function resolveUnitCoverageFlags(
  riskLevel?: UnitCoverageRiskLevel,
  duration?: UnitCoverageDuration
): UnitCoverageFlags {
  // 风险累计展开：所选档位及更低档位（harmless/dangerous/critical）全部纳入
  const riskFlags: Record<UnitCoverageRiskLevel, [boolean, boolean, boolean]> = {
    HARMLESS: [true, false, false],
    DANGEROUS: [true, true, false],
    CRITICAL: [true, true, true]
  }
  const [harmless, dangerous, critical] = riskFlags[riskLevel ?? 'HARMLESS']

  // 时长累计展开：所选档位及更低时长（short/medium/long）全部纳入；
  // 缺省取 MEDIUM 等效集（short+medium），与 VSP DefaultUnitTestFlags 一致
  const durationFlags: Record<UnitCoverageDuration, [boolean, boolean, boolean]> = {
    SHORT: [true, false, false],
    MEDIUM: [true, true, false],
    LONG: [true, true, true]
  }
  const [short, medium, long] = durationFlags[duration ?? 'MEDIUM']

  return { harmless, dangerous, critical, short, medium, long }
}

/* ==========================================================================
 * 对象名规范化与 URI 推导
 * ==========================================================================
 * 业务规则（SAP 命名字符白名单，风格对齐 CdsDependencyApi.normalizeCdsObjectName）：
 *   - 统一大写（SAP 对象名大小写不敏感，统一大写便于断言/缓存/URI 拼接）；
 *   - 字符白名单 [A-Z0-9_/]（字母数字下划线与命名空间分隔符），空白与控制
 *     字符天然被排除，保证拼入请求 XML 的安全性；
 *   - PROGRAM/CLASS：单一对象名，不允许 '/'（含命名空间前缀的对象如 /NSG/ZPROG
 *     的 URI 推导规则不同，为避免歧义直接拒绝）；
 *   - FUNCTION_MODULE：必须为 GROUP/FUNC 复合格式（恰好一个 '/'），组段与
 *     模块段分别校验——函数模块的 ADT URI 由所属函数组推导，缺组无法定位。
 * 校验失败在发出任何 HTTP 请求之前抛错，绝不静默截断。
 */

/** PROGRAM/CLASS 名称长度上限（SAP 对象名标准上限 30）。 */
const UNIT_COVERAGE_NAME_MAX_LENGTH = 30
/** FUNCTION_MODULE 复合名总长上限（组 26 + 分隔符 1 + 模块 30 = 57）。 */
const UNIT_COVERAGE_FM_MAX_LENGTH = 57

/** 对象名字符白名单（大写化后校验）：字母数字下划线，命名空间/复合段分隔符。 */
const UNIT_COVERAGE_NAME_PATTERN = /^[A-Z0-9_/]+$/

/** 单段对象名（PROGRAM/CLASS、复合名的每一段）的规范化与校验。 */
function normalizeNameSegment(value: unknown, capability: string, max: number): string {
  const name = String(value ?? '').trim().toUpperCase()
  if (
    !name
    || name.length > max
    || !UNIT_COVERAGE_NAME_PATTERN.test(name)
    || name.startsWith('/') || name.endsWith('/') || name.includes('//')
  ) {
    throw new Error(
      `${capability}: objectName must be a non-empty SAP object name of at most ${max} characters, using letters, digits, underscore only.`
    )
  }
  return name
}

/**
 * 规范化测试对象名并按类型校验格式：
 * - PROGRAM/CLASS：单一名称，<=30 字符；
 * - FUNCTION_MODULE：GROUP/FUNC 复合名（恰好一个分隔符），总长 <=57，
 *   组段 <=26、模块段 <=30。
 */
export function normalizeUnitCoverageObjectName(
  value: unknown,
  objectType: UnitCoverageObjectType,
  capability: string
): string {
  if (objectType === 'FUNCTION_MODULE') {
    const raw = String(value ?? '').trim().toUpperCase()
    const segments = raw.split('/')
    if (segments.length !== 2) {
      throw new Error(
        `${capability}: for FUNCTION_MODULE, objectName must be FUNCTION_GROUP/FUNCTION_MODULE (exactly one '/'), e.g. ZFG_COV/ZFM_COV.`
      )
    }
    const [group, func] = segments
    // 组段按函数组名上限 26、模块段按函数模块名上限 30 分别校验
    normalizeNameSegment(group, capability, 26)
    const normalizedFunc = normalizeNameSegment(func, capability, 30)
    if (raw.length > UNIT_COVERAGE_FM_MAX_LENGTH) {
      throw new Error(
        `${capability}: combined FUNCTION_GROUP/FUNCTION_MODULE name exceeds ${UNIT_COVERAGE_FM_MAX_LENGTH} characters.`
      )
    }
    return `${group}/${normalizedFunc}`
  }
  const name = normalizeNameSegment(value, capability, UNIT_COVERAGE_NAME_MAX_LENGTH)
  // PROGRAM/CLASS 不允许 '/'：含命名空间前缀对象的 URI 推导规则不同，
  // 为避免歧义在发出请求前直接拒绝（'/' 仅用于 FUNCTION_MODULE 复合格式）
  if (name.includes('/')) {
    throw new Error(
      `${capability}: objectName must not contain '/' for ${objectType}; the '/' separator is reserved for FUNCTION_MODULE (FUNCTION_GROUP/FUNCTION_MODULE).`
    )
  }
  return name
}

/**
 * 由对象类型+对象名推导测试对象的 ADT URI（服务端推导，绝不接受调用方 URL）：
 *   PROGRAM         → /sap/bc/adt/programs/programs/<NAME>
 *   CLASS           → /sap/bc/adt/oo/classes/<NAME>
 *   FUNCTION_MODULE → /sap/bc/adt/functions/groups/<GROUP>/fmodules/<FUNC>
 * （路径风格对齐本项目 AbapCreationResolver/objectcreator 的 URI 惯例。）
 * 各段 encodeURIComponent 转义做纵深防御（白名单已保证无特殊字符）。
 */
export function deriveUnitTestObjectUri(
  objectType: UnitCoverageObjectType,
  objectName: string
): string {
  if (objectType === 'PROGRAM') {
    return `/sap/bc/adt/programs/programs/${encodeURIComponent(objectName)}`
  }
  if (objectType === 'CLASS') {
    return `/sap/bc/adt/oo/classes/${encodeURIComponent(objectName)}`
  }
  // FUNCTION_MODULE：objectName 为 GROUP/FUNC 复合名（normalize 已保证恰好一个 '/'）
  const [group, func] = objectName.split('/')
  return `/sap/bc/adt/functions/groups/${encodeURIComponent(group)}/fmodules/${encodeURIComponent(func)}`
}

/**
 * 解析响应前统一做"去命名空间 + 容错"的 XML 解析（风格对齐 CdsDependencyApi）。
 * removeNSPrefix 后 aunit:/adtcore: 前缀标签与属性均按本地名取值，与 VSP
 * parseCoverageResult 在解析前做字符串前缀清理（ReplaceAll "aunit:"/"adtcore:"）
 * 等效；解析失败返回 undefined，由调用方按"空结果"处理（对齐 VSP 容错语义）。
 */
function parseAdtXmlLenient(body: string): any {
  try {
    return fullParse(body, { removeNSPrefix: true })
  } catch {
    return undefined
  }
}

/**
 * 单项覆盖统计：按 VSP 口径聚合 total/covered，percent=covered/total*100
 * （VSP 同样自行计算而不信任 SAP 的 percentage 属性），保留 2 位小数收敛
 * 浮点显示噪声；total=0 时 percent 记 0（避免除零，VSP 同口径）。
 */
function coverageStats(nodes: any[]): UnitCoverageStats {
  let total = 0
  let covered = 0
  for (const node of nodes) {
    const attr = xmlNodeAttr(node)
    // parseAttributeValue 已把数字属性转成 number；容错兜底 Number() 转换
    total += Number(attr?.total) || 0
    covered += Number(attr?.covered) || 0
  }
  return {
    total,
    covered,
    percent: total > 0 ? Math.round((covered / total) * 100 * 100) / 100 : 0
  }
}

/** 节点上的告警（断言失败/异常/警告）数量；节点缺失时为 0。 */
function alertCount(node: any): number {
  return xmlArray<any>(node, 'alerts', 'alert').length
}

/** 解析单个测试方法节点为裁剪结果（名字/耗时/告警数/状态）。 */
function parseMethodResult(node: any): UnitCoverageMethodResult {
  const attr = xmlNodeAttr(node)
  const alerts = alertCount(node)
  const executionTime = Number(attr?.executionTime)
  return {
    name: String(attr?.name || ''),
    ...(Number.isFinite(executionTime) && attr?.executionTime !== undefined
      ? { executionTime }
      : {}),
    alertCount: alerts,
    status: alerts > 0 ? 'alerts' : 'passed'
  }
}

/** 解析单个测试类节点为裁剪结果（含方法清单与汇总告警数）。 */
function parseClassResult(node: any): UnitCoverageClassResult {
  const attr = xmlNodeAttr(node)
  // 类级告警 + 全部方法级告警求和（类节点的 alerts>alert 只匹配直接子路径，
  // 不会把方法内嵌套的 alert 重复计入）
  const methods = xmlFlatArray<any>(node, 'testMethods', 'testMethod').map(parseMethodResult)
  const alerts = alertCount(node) + methods.reduce((sum, m) => sum + m.alertCount, 0)
  return {
    name: String(attr?.name || ''),
    ...(attr?.type ? { type: String(attr.type) } : {}),
    ...(attr?.riskLevel ? { riskLevel: String(attr.riskLevel) } : {}),
    ...(attr?.durationCategory ? { durationCategory: String(attr.durationCategory) } : {}),
    alertCount: alerts,
    status: alerts > 0 ? 'alerts' : 'passed',
    testMethods: methods
  }
}

/* ==========================================================================
 * 执行入口：运行单元测试并读取行级覆盖率
 * ==========================================================================
 * VSP 来源：pkg/adt/testing.go GetCodeCoverage（第 39-80 行）与
 * parseCoverageResult（第 82-171 行）。
 *
 * 请求体对齐 VSP GetCodeCoverage：与本项目 runUnitTest（src/adt/api/unittest.ts
 * runUnitTest）同模板，唯一差异是 <coverage active="true"/> 打开覆盖率采集
 * （runUnitTest 为 active="false"）。对象引用仅一条，URI 由服务端从
 * objectType+objectName 推导并经 encodeEntity 转义。
 */
export async function runUnitCoverage(
  h: AdtHTTP,
  input: UnitCoverageQuery
): Promise<UnitCoverageResult> {
  // 业务规则：objectType 必须在白名单内；objectName 先规范化校验，失败即抛，
  // 不发出任何 HTTP 请求
  const objectType = input?.objectType
  if (objectType !== 'PROGRAM' && objectType !== 'CLASS' && objectType !== 'FUNCTION_MODULE') {
    throw new Error(
      'runUnitCoverage: objectType must be one of PROGRAM, CLASS, FUNCTION_MODULE.'
    )
  }
  const objectName = normalizeUnitCoverageObjectName(input?.objectName, objectType, 'runUnitCoverage')
  const objectUri = deriveUnitTestObjectUri(objectType, objectName)
  const flags = resolveUnitCoverageFlags(input?.riskLevel, input?.duration)

  // 请求 XML：模板与标志展开对齐 VSP GetCodeCoverage（testing.go 第 45-67 行）；
  // coverage active="true" 是本能力与普通 unitTestRun 的唯一协议差异
  const body = `<?xml version="1.0" encoding="UTF-8"?>
  <aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">
  <external>
    <coverage active="true"/>
  </external>
  <options>
    <uriType value="semantic"/>
    <testDeterminationStrategy sameProgram="true" assignedTests="false"/>
    <testRiskLevels harmless="${flags.harmless}" dangerous="${flags.dangerous}" critical="${flags.critical}"/>
    <testDurations short="${flags.short}" medium="${flags.medium}" long="${flags.long}"/>
    <withNavigationUri enabled="true"/>
  </options>
  <adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core">
    <objectSet kind="inclusive">
      <adtcore:objectReferences>
        <adtcore:objectReference adtcore:uri="${encodeEntity(objectUri)}"/>
      </adtcore:objectReferences>
    </objectSet>
  </adtcore:objectSets>
</aunit:runConfiguration>`

  // 头与端点逐字对齐 VSP GetCodeCoverage / 本项目 runUnitTest
  const response = await h.request('/sap/bc/adt/abapunit/testruns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/*', Accept: 'application/*' },
    body
  })

  // HTTP 错误已在上方原样抛出；此处解析只会成功或返回空结果（不抛错）
  return parseUnitCoverageResult(response.body, {
    objectName,
    objectType,
    objectUri,
    flags
  })
}

/**
 * 解析 testruns 响应 XML 为精简执行+覆盖率结果。
 * - 测试类执行结果路径：runResult > program > testClasses > testClass
 *   （program/testClass/testMethod 可能因数量为 1 而非数组，xmlFlatArray 统一
 *   处理，解析口径与本项目 runUnitTest 一致）；
 * - 覆盖率路径：runResult > coverage > statement/branch/procedure > node，
 *   字段口径对齐 VSP parseCoverageResult（statement/branch/procedure 分别聚合，
 *   带 uri 属性的 statement node 额外进入 sourceCoverage 按 URI 索引）；
 * - 结构不符合预期（空响应/无 coverage 段/根节点异常）时返回零值+空清单，
 *   不抛错——对齐 VSP "coverage 数据不在预期格式则返回空"的容错语义。
 */
function parseUnitCoverageResult(
  body: string,
  context: {
    objectName: string
    objectType: UnitCoverageObjectType
    objectUri: string
    flags: UnitCoverageFlags
  }
): UnitCoverageResult {
  const raw = parseAdtXmlLenient(body)
  // 根节点 runResult；容错回退 xmlRoot（应对根名带未知前缀的场景）
  const runResult = raw?.runResult ?? xmlRoot(raw)

  // 每测试类执行结果（program 层随系统版本可能多/单/缺失，统一展平）
  const testClasses = xmlFlatArray<any>(
    runResult,
    'program',
    'testClasses',
    'testClass'
  ).map(parseClassResult)

  // coverage 段缺失（系统未启用覆盖率采集）时三个维度均为零值、源清单为空
  const coverage = runResult?.coverage
  const statementNodes = xmlArray<any>(coverage, 'statement', 'node')
  const branchNodes = xmlArray<any>(coverage, 'branch', 'node')
  const procedureNodes = xmlArray<any>(coverage, 'procedure', 'node')

  // 按 URI 索引的语句级源覆盖（对齐 VSP SourceCoverage：仅 statement 维度）
  const sourceCoverage: Record<string, UnitCoverageSourceEntry> = {}
  for (const node of statementNodes) {
    const attr = xmlNodeAttr(node)
    if (!attr?.uri) continue
    const total = Number(attr?.total) || 0
    const covered = Number(attr?.covered) || 0
    sourceCoverage[String(attr.uri)] = {
      uri: String(attr.uri),
      ...(attr?.type ? { type: String(attr.type) } : {}),
      ...(attr?.name ? { name: String(attr.name) } : {}),
      statements: {
        total,
        covered,
        percent: total > 0 ? Math.round((covered / total) * 100 * 100) / 100 : 0
      }
    }
  }

  const alertTotal = testClasses.reduce((sum, c) => sum + c.alertCount, 0)
  const methodTotal = testClasses.reduce((sum, c) => sum + c.testMethods.length, 0)

  return {
    objectName: context.objectName,
    objectType: context.objectType,
    objectUri: context.objectUri,
    flags: context.flags,
    execution: {
      testClasses,
      summary: {
        testClassCount: testClasses.length,
        testMethodCount: methodTotal,
        alertCount: alertTotal
      }
    },
    coverage: {
      statements: coverageStats(statementNodes),
      branches: coverageStats(branchNodes),
      procedures: coverageStats(procedureNodes),
      sourceCoverage
    }
  }
}

/* ==========================================================================
 * 客户端绑定（供后续集成任务接线的注入点）
 * ==========================================================================
 * 窄接口；UnitCoverageHandlers（src/handlers/UnitCoverageHandlers.ts）以此为
 * 构造注入边界，便于 mock 与按 profile 装配。
 */
export interface UnitCoverageClient {
  runUnitCoverage(input: UnitCoverageQuery): Promise<UnitCoverageResult>
}

/**
 * 把 AdtHTTP 会话绑定成 UnitCoverageClient。
 * 集成任务接线方式：createUnitCoverageClient(client.h)（AdtClient 通过公开
 * getter `h` 暴露内部 AdtHTTP 会话）；本任务不改动 AdtClient/index 接线。
 */
export function createUnitCoverageClient(h: AdtHTTP): UnitCoverageClient {
  return {
    runUnitCoverage: input => runUnitCoverage(h, input)
  }
}
