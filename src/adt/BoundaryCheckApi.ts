import { extractDependencies, type Dependency } from './ContextCompressionApi.js'
import { normalizeRepositoryName } from './CrossReferenceApi.js'

/**
 * ============================================================================
 * 包边界只读检查 API（关闭能力矩阵缺口 analysis.boundaries 的只读子集）
 * ============================================================================
 *
 * 回答 clean core 的核心问题：一个 Z 包内的对象，跨包引用了哪些别的 Z 包？
 * 判定口径对齐 VSP vibing-steampunk pkg/graph/boundary.go CheckBoundaries
 * （L67-190）的六类裁定：
 *   STANDARD（SAP 标准包，OK）/ SAME_PACKAGE（同包，OK）/ ALLOWED（白名单
 *   Z 包，OK）/ VIOLATION（跨包 Z 依赖，问题）/ DYNAMIC（动态调用，未解析
 *   警告）/ UNKNOWN（包未解析）。
 *
 * 实现路径（与 VSP 的架构差异，语义对齐）：
 *   - VSP 基于预构建的内存图（TADIR + 源码扫描批量入图，builder_*.go）；
 *     本实现按需即时分析：TADIR 枚举包内对象（自由 SQL）→ 逐对象读源码 →
 *     ContextCompressionApi.extractDependencies 提取依赖 → TADIR 反查依赖
 *     目标包 → 逐边裁定。
 *   - 只处理源码型对象（PROG/CLAS/INTF）——依赖提取是源码正则层，表结构类
 *     对象（TABL/DTEL）没有可提取的代码依赖。
 *   - DYNAMIC（动态调用 CALL METHOD (name) 等）检测未实现：报告的
 *     dynamic 恒为 0，notes 如实标注该差异。
 *
 * 业务规则：
 *   - 全部只读：TADIR SELECT + 源码 GET，无锁无传输无写入。
 *   - 注入防线：包名/对象名走仓库名白名单（normalizeRepositoryName），
 *     目标包查询的 IN 字面量由内部拼装（数据来自 TADIR 而非调用方）。
 *   - 有界执行：对象数默认/上限收敛（默认 10，上限 30），依赖目标包反查
 *     按名字去重合并为按 kind 分组的 IN 批查询（每 kind 一条 SQL）。
 */

/** 支持依赖分析的对象类型（TADIR OBJECT 值）。 */
export type BoundaryObjectKind = 'PROG' | 'CLAS' | 'INTF'

/** 边界裁定（VSP BoundaryVerdict，boundary.go L11-19）。 */
export type BoundaryVerdict =
  | 'STANDARD'
  | 'SAME_PACKAGE'
  | 'ALLOWED'
  | 'VIOLATION'
  | 'DYNAMIC'
  | 'UNKNOWN'

/** 单条依赖及其裁定（VSP BoundaryEntry 的精简等价）。 */
export interface BoundaryEntry {
  /** 引用方对象（包内）。 */
  from: string
  /** 被引用对象。 */
  to: string
  /** 被引用对象种类（CLAS/INTF/FUNC）。 */
  toKind: Dependency['kind']
  /** 裁定。 */
  verdict: BoundaryVerdict
  /** 依赖目标所在包（未知为空串）。 */
  targetPackage: string
}

/** 边界检查报告（VSP BoundaryReport 的等价精简）。 */
export interface BoundaryReport {
  rootPackage: string
  /** 生效白名单（大写）。 */
  whitelist: string[]
  /** 分析的对象数。 */
  analyzedObjects: number
  totalDeps: number
  entries: BoundaryEntry[]
  standard: number
  samePackage: number
  allowed: number
  violations: number
  dynamic: number
  unknown: number
  /** 被跨入的包 → 次数（仅非 STANDARD）。 */
  crossedPackages: Record<string, number>
  /** 存在 VIOLATION 的对象清单。 */
  violatingObjects: string[]
  /** 边界说明（动态调用检测未实现等）。 */
  notes: string[]
}

/** checkPackageBoundaries 的输入。 */
export interface BoundaryCheckInput {
  /** 要分析的 Z 包名。 */
  packageName: string
  /** 白名单（允许跨入的 Z 包，支持 * 通配，如 Z*_COMMON、$ZUTIL*）。 */
  whitelist?: string[]
  /** 分析的对象种类，默认 PROG+CLAS+INTF。 */
  objectKinds?: BoundaryObjectKind[]
  /** 分析对象数上限：默认 10，上限 30（控制串行取源耗时）。 */
  objectLimit?: number
  /** 包内对象名过滤（精确前缀，如 ZVCL*）。 */
  namePattern?: string
}

/** 项目 ADT 客户端最小结构视图 + 自由 SQL 通道。 */
export interface BoundaryCheckCapability {
  searchObject(query: string, objType?: string, max?: number): Promise<Array<Record<string, any>>>
  objectStructure(objectUrl: string, version?: string): Promise<any>
  getObjectSource(objectSourceUrl: string, options?: unknown): Promise<string>
  runQuery(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>
}

/** 默认与上限（串行取源耗时可控）。 */
export const DEFAULT_OBJECT_LIMIT = 10
export const MAX_OBJECT_LIMIT = 30

/** 标准包判定：不以 Z/Y（含 /Z、/Y 命名空间）开头的包视为 SAP 标准。 */
function isStandardPackage(pkg: string): boolean {
  const upper = pkg.toUpperCase()
  return !(upper.startsWith('Z') || upper.startsWith('Y') || upper.startsWith('/Z') || upper.startsWith('/Y'))
}

/** 白名单 glob → 正则（* 任意长度，? 单字符，大小写不敏感）。 */
function whitelistMatcher(patterns: readonly string[]): (pkg: string) => boolean {
  if (patterns.length === 0) return () => false
  const regexes = patterns.map(pattern => {
    const escaped = pattern
      .toUpperCase()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    return new RegExp(`^${escaped}$`)
  })
  return pkg => regexes.some(re => re.test(pkg.toUpperCase()))
}

/** 依赖种类 → TADIR OBJECT 值（FUNC 的 TADIR OBJECT 也是 'FUNC'）。 */
function tadirObjectFor(kind: Dependency['kind']): string {
  return kind === 'FUNC' ? 'FUNC' : kind
}

/**
 * 执行包边界只读检查。
 *
 * 步骤（全串行、有界）：
 *   1. TADIR 枚举包内对象（objectKinds 过滤，namePattern 前缀过滤）；
 *   2. 逐对象取源码并 extractDependencies；
 *   3. 全部依赖按 kind 分组，TADIR 批查目标包（obj_name IN (...)）；
 *   4. 逐依赖裁定并聚合（crossedPackages / violatingObjects）。
 */
export async function checkPackageBoundaries(
  client: BoundaryCheckCapability,
  input: BoundaryCheckInput
): Promise<BoundaryReport> {
  const capability = 'checkPackageBoundaries'
  const rootPackage = normalizeRepositoryName(input?.packageName, capability)
  const whitelist = (input?.whitelist ?? []).map(p => String(p).trim().toUpperCase()).filter(p => p !== '')
  const matchWhitelist = whitelistMatcher(whitelist)
  const kinds: BoundaryObjectKind[] =
    input?.objectKinds && input.objectKinds.length > 0
      ? input.objectKinds
      : ['PROG', 'CLAS', 'INTF']
  for (const kind of kinds) {
    if (!['PROG', 'CLAS', 'INTF'].includes(kind)) {
      throw new Error(`${capability}: objectKinds only supports PROG, CLAS, INTF (source-bearing kinds).`)
    }
  }
  const requested = Number(input?.objectLimit ?? DEFAULT_OBJECT_LIMIT)
  const objectLimit = Math.min(
    Math.max(Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_OBJECT_LIMIT, 1),
    MAX_OBJECT_LIMIT
  )
  const namePattern = typeof input?.namePattern === 'string' ? input.namePattern.trim().toUpperCase() : ''

  // 1) TADIR 枚举包内对象
  const kindList = kinds.map(k => `'${k}'`).join(', ')
  const tadirRows =
    (
      await client.runQuery(
        `SELECT obj_name, object FROM tadir WHERE pgmid = 'R3TR' AND devclass = '${rootPackage}'`
        + ` AND object IN (${kindList}) ORDER BY obj_name`,
        objectLimit
      )
    ).values ?? []

  const objects = tadirRows
    .map(row => ({
      name: String(row['OBJ_NAME'] ?? row['obj_name'] ?? '').trim().toUpperCase(),
      kind: String(row['OBJECT'] ?? row['object'] ?? '').trim().toUpperCase() as BoundaryObjectKind
    }))
    .filter(o => o.name !== '' && (!namePattern || o.name.startsWith(namePattern)))
    .slice(0, objectLimit)

  const notes = [
    'read-only subset: dynamic-call detection (VSP DYNAMIC verdict) is not implemented, dynamic is always 0',
    'dependencies are extracted from source text by regex; only CLAS/INTF/FUNC references are resolved'
  ]

  if (objects.length === 0) {
    return {
      rootPackage,
      whitelist,
      analyzedObjects: 0,
      totalDeps: 0,
      entries: [],
      standard: 0,
      samePackage: 0,
      allowed: 0,
      violations: 0,
      dynamic: 0,
      unknown: 0,
      crossedPackages: {},
      violatingObjects: [],
      notes
    }
  }

  // 2) 逐对象串行取源码并提取依赖
  const depsByObject = new Map<string, Dependency[]>()
  const allDeps = new Map<string, Dependency['kind']>()
  for (const obj of objects) {
    let source = ''
    try {
      // 对象源 URL 解析（searchObject → objectStructure → 源 URI）
      const searchResults = await client.searchObject(obj.name, undefined, 50)
      const uri = resolveObjectUriFromSearch(searchResults ?? [], obj.kind, obj.name)
      if (!uri) {
        depsByObject.set(obj.name, [])
        continue
      }
      source = await readObjectSource(client, uri)
    } catch {
      // 读不到源码的对象：记 0 依赖继续（不中断整体分析）
      depsByObject.set(obj.name, [])
      continue
    }
    const deps = extractDependencies(source)
    depsByObject.set(obj.name, deps)
    for (const d of deps) allDeps.set(d.name, d.kind)
  }

  // 3) 依赖目标包批查：按 kind 分组，obj_name IN (...)
  const byKind = new Map<string, Set<string>>()
  for (const [name, kind] of allDeps) {
    const tadirObject = tadirObjectFor(kind)
    let set = byKind.get(tadirObject)
    if (!set) {
      set = new Set<string>()
      byKind.set(tadirObject, set)
    }
    set.add(name)
  }
  const targetPackage = new Map<string, string>()
  for (const [tadirObject, names] of byKind) {
    const literals = [...names].map(n => `'${n}'`).join(', ')
    const rows =
      (
        await client.runQuery(
          `SELECT obj_name, devclass FROM tadir WHERE pgmid = 'R3TR' AND object = '${tadirObject}'`
          + ` AND obj_name IN (${literals})`,
          names.size
        )
      ).values ?? []
    for (const row of rows) {
      const name = String(row['OBJ_NAME'] ?? row['obj_name'] ?? '').trim().toUpperCase()
      const devclass = String(row['DEVCLASS'] ?? row['devclass'] ?? '').trim().toUpperCase()
      if (name && devclass) targetPackage.set(name, devclass)
    }
  }

  // 4) 逐依赖裁定 + 聚合（口径对齐 VSP boundary.go L120-190）
  const entries: BoundaryEntry[] = []
  const report: BoundaryReport = {
    rootPackage,
    whitelist,
    analyzedObjects: objects.length,
    totalDeps: 0,
    entries,
    standard: 0,
    samePackage: 0,
    allowed: 0,
    violations: 0,
    dynamic: 0,
    unknown: 0,
    crossedPackages: {},
    violatingObjects: [],
    notes
  }
  const violating = new Set<string>()

  for (const obj of objects) {
    for (const dep of depsByObject.get(obj.name) ?? []) {
      const targetPkg = targetPackage.get(dep.name) ?? ''
      let verdict: BoundaryVerdict
      if (targetPkg === '') {
        verdict = 'UNKNOWN'
        report.unknown++
      } else if (dep.name === obj.name || targetPkg === rootPackage) {
        verdict = 'SAME_PACKAGE'
        report.samePackage++
      } else if (isStandardPackage(targetPkg)) {
        verdict = 'STANDARD'
        report.standard++
      } else if (matchWhitelist(targetPkg)) {
        verdict = 'ALLOWED'
        report.allowed++
      } else {
        verdict = 'VIOLATION'
        report.violations++
        violating.add(obj.name)
        report.crossedPackages[targetPkg] = (report.crossedPackages[targetPkg] ?? 0) + 1
      }
      report.totalDeps++
      if (verdict !== 'STANDARD') {
        entries.push({
          from: obj.name,
          to: dep.name,
          toKind: dep.kind,
          verdict,
          targetPackage: targetPkg
        })
      }
    }
  }
  report.violatingObjects = [...violating].sort()
  return report
}

/** 从 quick search 结果解析对象 URI（口径对齐 ContextCompressionApi）。 */
function resolveObjectUriFromSearch(
  results: Array<Record<string, any>>,
  kind: BoundaryObjectKind,
  name: string
): string | undefined {
  const matches = results.filter(result => {
    let uri = String(result['adtcore:uri'] ?? '')
    try {
      uri = decodeURIComponent(uri)
    } catch {
      /* 保留原值 */
    }
    uri = uri.toUpperCase()
    const resultName = String(result['adtcore:name'] ?? '').toUpperCase()
    const adtType = String(result['adtcore:type'] ?? '').toUpperCase()
    const byName = resultName === name
    if (!byName) return false
    switch (kind) {
      case 'CLAS': return adtType.startsWith('CLAS/') || uri.includes('/OO/CLASSES/')
      case 'INTF': return adtType.startsWith('INTF/') || uri.includes('/OO/INTERFACES/')
      case 'PROG': return adtType.startsWith('PROG/P') || uri.includes('/PROGRAMS/PROGRAMS/')
    }
  })
  const first = matches[0]
  return first ? String(first['adtcore:uri'] ?? '') : undefined
}

/** 读对象源码：objectStructure 取源 URI（main include 优先）→ 相对 URI 绝对化 → GET。 */
async function readObjectSource(
  client: BoundaryCheckCapability,
  objectUri: string
): Promise<string> {
  const structure = await client.objectStructure(objectUri, 'active')
  const classIncludes: Array<Record<string, any>> = structure && 'includes' in structure ? structure.includes : []
  const mainInclude = classIncludes.find(include => include['class:includeType'] === 'main')
  const rawSourceUrl = mainInclude?.['abapsource:sourceUri'] || structure?.metaData?.['abapsource:sourceUri']
  if (!rawSourceUrl) {
    throw new Error('ADT metadata provided no source URI')
  }
  const normalized = String(rawSourceUrl).trim()
  let sourceUrl: string
  if (normalized.startsWith('/sap/bc/adt/')) {
    sourceUrl = normalized
  } else {
    const relative = normalized.replace(/^\.\//, '')
    if (!relative || relative.startsWith('/') || relative.includes('..') || relative.includes('://') || /[?#]/.test(relative)) {
      throw new Error('ADT returned an invalid source URI')
    }
    sourceUrl = `${objectUri.replace(/\/+$/, '')}/${relative}`
  }
  return await client.getObjectSource(sourceUrl)
}

/** 处理器注入用的窄客户端接口。 */
export interface BoundaryCheckClient {
  checkPackageBoundaries(input: BoundaryCheckInput): Promise<BoundaryReport>
}

/** 把 ADT 客户端绑定成处理器可注入的窄客户端（串行执行由调用方会话保证）。 */
export function createBoundaryCheckClient(client: BoundaryCheckCapability): BoundaryCheckClient {
  return {
    checkPackageBoundaries: input => checkPackageBoundaries(client, input)
  }
}
