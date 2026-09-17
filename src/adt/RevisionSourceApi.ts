import { revisions, type Revision } from './api/revisions.js'
import { normalizeRepositoryName } from './CrossReferenceApi.js'

/**
 * 项目 ADT 客户端的最小结构视图（duck typing；供版本源码与版本对比两个
 * 只读能力共用）：searchObject 精确解析对象、revisions 版本清单、
 * objectStructure 取当前源 URI、getObjectSource 读源码。
 */
export interface RevisionSourceCapability {
  searchObject(query: string, objType?: string, max?: number): Promise<Array<Record<string, any>>>
  revisions(objectUrl: string, clsInclude?: string): Promise<Revision[]>
  objectStructure(objectUrl: string, version?: string): Promise<any>
  getObjectSource(objectSourceUrl: string, options?: unknown): Promise<string>
}

/**
 * ============================================================================
 * 版本源码只读 ADT API（关闭能力矩阵缺口 revisions.source）
 * ============================================================================
 *
 * 回答"这个对象的上一个激活版本/某个历史版本的源码长什么样"——任务链两段：
 *   1. `revisions`（既有工具）列出对象的版本清单（每个条目自带该版本的
 *      源 URI：atom:content 的 src，见 src/adt/api/revisions.ts L83）；
 *   2. 本 API 补齐第二段：按版本标签或清单序号取回那一版源码文本。
 * 对齐 VSP vibing-steampunk 的 SAP(action=revisions, params={op:source}) 与
 * focused GetRevisionSource（internal/mcp/handlers_revisions.go L41-56、
 * pkg/adt client.go——GetRevisionSource(versionURI) 即对该 URI GET 源文本）。
 *
 * 与 VSP 的参数面差异（安全取舍）：VSP 的 version_uri 由调用方直接传入；
 * 本实现只接受 objectType+objectName+版本选择器（标签或清单序号），对象与
 * 版本 URI 全部由服务端自行解析获得，不接受任意 URL——与本项目
 * "URL 由名称推导"的只读边界一致。解析链复用
 * ContextCompressionApi.createSourceFetcher 已真机验证的 searchObject 精确
 * 匹配 → objectStructure → 源 URI（相对 URI 绝对化）路径。
 *
 * 业务规则：
 *   - 纯只读（quick search/structure/版本清单/源码 GET），无锁无激活无写入。
 *   - 版本选择器二选一：version（版本标签，对 version/versionTitle 不区分
 *   - 大小写精确匹配，如 ACTIVE / 20260917081234）或 index（清单中的 1-based
 *     序号，清单按最新在前排序，与 revisions 工具输出一致）。都不给则为
 *     "发现模式"：只返回版本清单与选择提示，不读源码。
 */

/** 支持的对象类型（解析链与 ContextCompressionApi 的 SourceKind 一致）。 */
export type RevisionSourceKind = 'CLAS' | 'INTF' | 'FUNC' | 'PROG'

/** 版本清单条目（对齐 api/revisions.ts Revision 的对外形态）。 */
export interface RevisionSummary {
  /** 版本标签（版本链接的 adtcore:name，如 ACTIVE）。 */
  version: string
  /** 版本标题（feed 条目标题，历史版本常为时间戳文本）。 */
  versionTitle: string
  /** 版本日期（feed atom:updated）。 */
  date: string
  /** 修改者。 */
  author: string
}

/** getRevisionSource 的返回（发现模式无 source 字段）。 */
export interface GetRevisionSourceResult {
  objectType: RevisionSourceKind
  objectName: string
  /** 命中的版本标签。 */
  version: string
  /** 该版本的修改日期与作者（清单条目自带）。 */
  date?: string
  author?: string
  /** 版本源码文本（发现模式下缺失）。 */
  source?: string
  lines?: number
  /** 发现模式：可用的版本选择器清单。 */
  availableVersions?: RevisionSummary[]
  /** 发现模式提示。 */
  message?: string
}

/** 输入校验：对象名白名单复用 CrossReferenceApi.normalizeRepositoryName
 *  （A-Z 0-9 _ / $、≤40、注入样本拒绝），避免双份实现漂移。 */

/**
 * 从 quick search 结果里挑出"名字与种类都精确匹配"的唯一对象（口径与
 * ContextCompressionApi.pickExactObject 一致：匹配 safe/AbapObjectResolver
 * matchesObject 的只读子集，含 INTF 家族）。
 */
function pickExactObject(
  results: Array<Record<string, any>>,
  kind: RevisionSourceKind,
  name: string
): Record<string, any> | undefined {
  const matches = results.filter(result => {
    let uri = String(result['adtcore:uri'] ?? '')
    try {
      uri = decodeURIComponent(uri)
    } catch {
      /* 保留原值 */
    }
    uri = uri.toUpperCase()
    const resultName = String(result['adtcore:name'] ?? '').toUpperCase()
    const exactName = resultName === name || uriIncludesObjectName(uri, name)
    if (!exactName) return false
    const adtType = String(result['adtcore:type'] ?? '').toUpperCase()
    switch (kind) {
      case 'CLAS': return adtType.startsWith('CLAS/') || uri.includes('/OO/CLASSES/')
      case 'INTF': return adtType.startsWith('INTF/') || uri.includes('/OO/INTERFACES/')
      case 'PROG': return adtType.startsWith('PROG/P') || uri.includes('/PROGRAMS/PROGRAMS/')
      case 'FUNC': return uri.includes('/FUNCTIONS/GROUPS/') && uri.includes('/FMODULES/')
    }
  })
  return matches.length === 1 ? matches[0] : undefined
}

/** 从 URI 末段推对象名（与 ContextCompressionApi 同口径）。 */
function uriIncludesObjectName(uri: string, name: string): boolean {
  const markers = ['/OO/CLASSES/', '/OO/INTERFACES/', '/PROGRAMS/PROGRAMS/', '/FMODULES/']
  for (const marker of markers) {
    const idx = uri.indexOf(marker)
    if (idx >= 0) {
      const rest = uri.slice(idx + marker.length)
      const end = rest.search(/[?(]/)
      return (end >= 0 ? rest.slice(0, end) : rest) === name
    }
  }
  return false
}

/**
 * 读取指定历史版本的源码。
 *
 * @param client 注入的只读能力（searchObject/revisions/getObjectSource）
 * @param input objectType+objectName 必填；version（标签精确匹配，大小写
 *   不敏感）或 index（清单 1-based 序号，最新在前）二选一；都不给则返回
 *   版本清单（发现模式）。
 */
export async function getRevisionSource(
  client: RevisionSourceCapability,
  input: { objectType: RevisionSourceKind; objectName: string; version?: string; index?: number }
): Promise<GetRevisionSourceResult> {
  const capability = 'getRevisionSource'
  if (!input || typeof input !== 'object') {
    throw new Error(`${capability}: input object is required.`)
  }
  const rawKind = String(input.objectType ?? '').trim().toUpperCase() as RevisionSourceKind
  if (rawKind !== 'CLAS' && rawKind !== 'INTF' && rawKind !== 'FUNC' && rawKind !== 'PROG') {
    throw new Error(`${capability}: objectType must be one of CLAS, INTF, FUNC, PROG.`)
  }
  const objectName = normalizeRepositoryName(input.objectName, capability)

  // 1) 对象解析：quick search 精确匹配（与依赖上下文取源链同路径）
  const searchResults = await client.searchObject(objectName, undefined, 50)
  const exact = pickExactObject(searchResults ?? [], rawKind, objectName)
  if (!exact) {
    throw new Error(`${capability}: no unique ${rawKind} object named ${objectName} was found by quick search.`)
  }
  const objectUri = String(exact['adtcore:uri'] ?? '')
  if (!objectUri) {
    throw new Error(`${capability}: quick search returned no URI for ${rawKind} ${objectName}.`)
  }

  // 2) 版本清单（清单按最新在前，与 revisions 工具输出一致）
  const revisionList = (await client.revisions(objectUri)) ?? []
  const summaries: RevisionSummary[] = revisionList.map(entry => ({
    version: String(entry.version ?? ''),
    versionTitle: String(entry.versionTitle ?? ''),
    date: String(entry.date ?? ''),
    author: String(entry.author ?? '')
  }))

  // 3) 版本选择：都未提供 → 发现模式
  const wantsVersion = input.version !== undefined && String(input.version).trim() !== ''
  const wantsIndex = input.index !== undefined
  if (!wantsVersion && !wantsIndex) {
    return {
      objectType: rawKind,
      objectName,
      version: '',
      availableVersions: summaries,
      message:
        `Discovery mode: ${summaries.length} revisions found for ${objectName}. `
        + 'Pass version (the label above, case-insensitive) or index (1-based position in this list, newest first) to read that version\'s source.'
    }
  }

  let entry: Revision | undefined
  if (wantsVersion) {
    const wanted = String(input.version).trim().toUpperCase()
    entry = revisionList.find(e =>
      String(e.version ?? '').toUpperCase() === wanted || String(e.versionTitle ?? '').toUpperCase() === wanted
    )
  } else {
    const index = Number(input.index)
    // index 为清单中的 1-based 序号（最新在前），收敛到 [1, 清单长度]
    if (Number.isFinite(index) && index >= 1 && index <= revisionList.length) {
      entry = revisionList[Math.floor(index) - 1]
    }
  }
  if (!entry) {
    const labels = summaries.map(s => s.version || s.versionTitle).filter(Boolean)
    throw new Error(
      `${capability}: requested revision was not found for ${objectName}`
      + (labels.length > 0 ? ` (available: ${labels.slice(0, 5).join(', ')}${labels.length > 5 ? ', ...' : ''})` : '')
    )
  }
  if (!entry.uri) {
    throw new Error(`${capability}: revision entry carries no source URI.`)
  }

  // 4) 版本源码读取（entry.uri 来自 ADT 版本清单，非调用方输入）
  const source = await client.getObjectSource(entry.uri)
  return {
    objectType: rawKind,
    objectName,
    version: String(entry.version ?? ''),
    ...(entry.date ? { date: String(entry.date) } : {}),
    ...(entry.author ? { author: String(entry.author) } : {}),
    source,
    lines: source.split('\n').length
  }
}

/** 处理器注入用的窄客户端接口。 */
export interface RevisionSourceClient {
  getRevisionSource(input: {
    objectType: RevisionSourceKind
    objectName: string
    version?: string
    index?: number
  }): Promise<GetRevisionSourceResult>
  compareRevisions(input: CompareRevisionsInput): Promise<CompareRevisionsResult>
  compareSourceObjects(input: CompareSourceObjectsInput): Promise<CompareSourceObjectsResult>
}

/** 把 ADT 客户端绑定成处理器可注入的窄客户端。 */
export function createRevisionSourceClient(client: RevisionSourceCapability): RevisionSourceClient {
  return {
    getRevisionSource: input => getRevisionSource(client, input),
    compareRevisions: input => compareRevisions(client, input),
    compareSourceObjects: input => compareSourceObjects(client, input)
  }
}

/* ==========================================================================
 * 版本对比（revisions.compare；VSP CompareVersions，pkg/adt/revisions.go
 * L69-119 与 workflows_source.go generateUnifiedDiff L1447-1560 的移植）
 * ========================================================================== */

/** compareRevisions 的过滤输入。 */
export interface CompareRevisionsInput {
  objectType: RevisionSourceKind
  objectName: string
  /** 基准版本：版本标签 / 清单序号（纯数字字符串，1-based）/ "current"。 */
  version1: string
  /** 对比版本：同上；缺省为 "current"（当前激活源码，VSP 同默认）。 */
  version2?: string
}

/** unified diff 的一块 hunk（对齐 VSP 的 @@ -a,b +c,d @@ 输出形态）。 */
export interface RevisionDiffHunk {
  header: string
  lines: string[]
}

/** compareRevisions 的返回（对齐 VSP SourceDiff 的等价结构）。 */
export interface CompareRevisionsResult {
  objectType: RevisionSourceKind
  objectName: string
  /** 基准版本标注（如 CLAS:ZCL_FOO@ACTIVE）。 */
  label1: string
  /** 对比版本标注。 */
  label2: string
  /** 两份源码是否逐字节相同。 */
  identical: boolean
  /** unified diff 文本（identical 时为说明文字）。 */
  diff: string
  addedLines: number
  removedLines: number
  /** 命中的版本条目元信息。 */
  revision1?: { version: string; date?: string; author?: string }
  revision2?: { version: string; date?: string; author?: string }
}

/**
 * 对象解析 + 版本清单获取（getRevisionSource 与 compareRevisions 共用的
 * 内部解析段；quick search 精确匹配，不接受任意 URL）。
 */
async function resolveObjectAndRevisions(
  client: RevisionSourceCapability,
  capability: string,
  objectType: RevisionSourceKind,
  objectName: string
): Promise<{ objectUri: string; revisionList: Revision[] }> {
  const searchResults = await client.searchObject(objectName, undefined, 50)
  const exact = pickExactObject(searchResults ?? [], objectType, objectName)
  if (!exact) {
    throw new Error(`${capability}: no unique ${objectType} object named ${objectName} was found by quick search.`)
  }
  const objectUri = String(exact['adtcore:uri'] ?? '')
  if (!objectUri) {
    throw new Error(`${capability}: quick search returned no URI for ${objectType} ${objectName}.`)
  }
  const revisionList = (await client.revisions(objectUri)) ?? []
  return { objectUri, revisionList }
}

/**
 * 按名字解析对象的当前源 URL（供 i18n 等只读能力复用）：quick search 精确
 * 匹配 → objectStructure 取源 URI（main include 优先）→ 相对 URI 绝对化。
 * 口径与 ContextCompressionApi.createSourceFetcher 一致。
 */
export async function resolveObjectSourceUrl(
  client: Pick<RevisionSourceCapability, 'searchObject' | 'objectStructure'>,
  objectType: RevisionSourceKind,
  objectName: string,
  capability: string
): Promise<string> {
  const searchResults = await client.searchObject(objectName, undefined, 50)
  const exact = pickExactObject(searchResults ?? [], objectType, objectName)
  if (!exact) {
    throw new Error(`${capability}: no unique ${objectType} object named ${objectName} was found by quick search.`)
  }
  const objectUri = String(exact['adtcore:uri'] ?? '')
  if (!objectUri) {
    throw new Error(`${capability}: quick search returned no URI for ${objectType} ${objectName}.`)
  }
  const structure = await client.objectStructure(objectUri, 'active')
  const classIncludes: Array<Record<string, any>> = structure && 'includes' in structure ? structure.includes : []
  const mainInclude = classIncludes.find(include => include['class:includeType'] === 'main')
  const rawSourceUrl = mainInclude?.['abapsource:sourceUri'] || structure?.metaData?.['abapsource:sourceUri']
  if (!rawSourceUrl) {
    throw new Error(`${capability}: ADT metadata provided no source URI for ${objectType} ${objectName}.`)
  }
  const normalized = String(rawSourceUrl).trim()
  if (normalized.startsWith('/sap/bc/adt/')) return normalized
  const relative = normalized.replace(/^\.\//, '')
  if (!relative || relative.startsWith('/') || relative.includes('..') || relative.includes('://') || /[?#]/.test(relative)) {
    throw new Error(`${capability}: ADT returned an invalid source URI.`)
  }
  return `${objectUri.replace(/\/+$/, '')}/${relative}`
}

/**
 * 版本选择器解析：标签精确匹配（version/versionTitle，大小写不敏感）或
 * 纯数字字符串按清单序号（1-based，最新在前）。选择器来自调用方字符串
 * （VSP CompareVersions 同样接受标签/URI 字面量）。
 */
function selectRevision(
  revisionList: readonly Revision[],
  selector: string
): Revision | undefined {
  const trimmed = selector.trim()
  // 纯数字 → 清单序号（1-based）
  if (/^\d+$/.test(trimmed)) {
    const index = parseInt(trimmed, 10)
    if (index >= 1 && index <= revisionList.length) {
      return revisionList[index - 1]
    }
    return undefined
  }
  const wanted = trimmed.toUpperCase()
  return revisionList.find(entry =>
    String(entry.version ?? '').toUpperCase() === wanted
    || String(entry.versionTitle ?? '').toUpperCase() === wanted
  )
}

/**
 * 读取当前激活源码（VSP CompareVersions 的 version2URI === "current" 分支，
 * revisions.go L80-84）：objectStructure → 源 URI（main include 优先）→
 * 相对 URI 绝对化 → getObjectSource。解析口径与
 * ContextCompressionApi.createSourceFetcher 一致。
 */
async function readCurrentSource(
  client: RevisionSourceCapability,
  objectType: RevisionSourceKind,
  objectName: string,
  objectUri: string
): Promise<string> {
  const structure = await client.objectStructure(objectUri, 'active')
  const classIncludes: Array<Record<string, any>> = structure && 'includes' in structure ? structure.includes : []
  const mainInclude = classIncludes.find(include => include['class:includeType'] === 'main')
  const rawSourceUrl = mainInclude?.['abapsource:sourceUri'] || structure?.metaData?.['abapsource:sourceUri']
  if (!rawSourceUrl) {
    throw new Error(`compareRevisions: ADT metadata provided no source URI for ${objectType} ${objectName}`)
  }
  // 相对源 URI 绝对化（口径对齐 read/AbapMemberSourceReader.resolveSourceUrl）
  const normalized = String(rawSourceUrl).trim()
  let sourceUrl: string
  if (normalized.startsWith('/sap/bc/adt/')) {
    sourceUrl = normalized
  } else {
    const relative = normalized.replace(/^\.\//, '')
    if (!relative || relative.startsWith('/') || relative.includes('..') || relative.includes('://') || /[?#]/.test(relative)) {
      throw new Error('compareRevisions: ADT returned an invalid source URI')
    }
    sourceUrl = `${objectUri.replace(/\/+$/, '')}/${relative}`
  }
  return await client.getObjectSource(sourceUrl)
}

/**
 * LCS 行级 diff + unified hunks（3 行上下文；VSP workflows_source.go
 * L1447-1560 的移植，hunk 头/上下文窗口/增删前缀逐项对齐）。
 */
export function unifiedDiff(label1: string, label2: string, source1: string, source2: string): {
  diff: string
  addedLines: number
  removedLines: number
} {
  const lines1 = source1.split('\n')
  const lines2 = source2.split('\n')
  const m = lines1.length
  const n = lines2.length

  // LCS 表（经典动态规划；源码体量数百行，O(m·n) 可接受）
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (lines1[i - 1] === lines2[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1])
      }
    }
  }

  // 回溯生成行序列（' ' 相同 / '+' 新增 / '-' 删除），从尾向前回填
  type DiffLine = { op: ' ' | '+' | '-'; text: string }
  const diffLines: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && lines1[i - 1] === lines2[j - 1]) {
      diffLines.unshift({ op: ' ', text: lines1[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      diffLines.unshift({ op: '+', text: lines2[j - 1] })
      j--
    } else {
      diffLines.unshift({ op: '-', text: lines1[i - 1] })
      i--
    }
  }

  // 输出 hunks：改动行前后各保留 3 行上下文，hunk 头带两侧行号区间
  const CONTEXT = 3
  const parts: string[] = [`--- ${label1}`, `+++ ${label2}`]
  let added = 0
  let removed = 0

  // 先标出每个位置是否落在改动邻近区（距最近改动 ≤CONTEXT 行）
  const changedAt = diffLines.map(l => l.op !== ' ')
  const inHunk = new Array<boolean>(diffLines.length).fill(false)
  for (let k = 0; k < diffLines.length; k++) {
    if (!changedAt[k]) continue
    for (let t = Math.max(0, k - CONTEXT); t <= Math.min(diffLines.length - 1, k + CONTEXT); t++) {
      inHunk[t] = true
    }
  }

  // 行号计数器：unified diff 头的起止行按"输出行的原行号"累计
  let line1 = 1
  let line2 = 1
  let k = 0
  while (k < diffLines.length) {
    if (!inHunk[k]) {
      // hunk 之外的相同行：跳过但仍推进行号
      if (diffLines[k].op === ' ') {
        line1++
        line2++
      }
      k++
      continue
    }
    // 收集一个 hunk：连续的 inHunk 区段
    const hunkLines: string[] = []
    const start1 = line1
    const start2 = line2
    let len1 = 0
    let len2 = 0
    while (k < diffLines.length && inHunk[k]) {
      const op = diffLines[k].op
      if (op === ' ') {
        hunkLines.push(` ${diffLines[k].text}`)
        len1++
        len2++
        line1++
        line2++
      } else if (op === '+') {
        hunkLines.push(`+${diffLines[k].text}`)
        len2++
        line2++
        added++
      } else {
        hunkLines.push(`-${diffLines[k].text}`)
        len1++
        line1++
        removed++
      }
      k++
    }
    parts.push(`@@ -${start1},${len1} +${start2},${len2} @@`)
    parts.push(...hunkLines)
  }

  return { diff: parts.join('\n'), addedLines: added, removedLines: removed }
}

/**
 * 对比两个版本的源码（VSP CompareVersions 的只读移植）。
 * version1/version2 接受版本标签、清单序号（纯数字字符串）或 "current"
 * （当前激活源码）；version2 缺省为 "current"。
 */
export async function compareRevisions(
  client: RevisionSourceCapability,
  input: CompareRevisionsInput
): Promise<CompareRevisionsResult> {
  const capability = 'compareRevisions'
  if (!input || typeof input !== 'object') {
    throw new Error(`${capability}: input object is required.`)
  }
  const rawKind = String(input.objectType ?? '').trim().toUpperCase() as RevisionSourceKind
  if (rawKind !== 'CLAS' && rawKind !== 'INTF' && rawKind !== 'FUNC' && rawKind !== 'PROG') {
    throw new Error(`${capability}: objectType must be one of CLAS, INTF, FUNC, PROG.`)
  }
  const objectName = normalizeRepositoryName(input.objectName, capability)
  const selector1 = String(input.version1 ?? '').trim()
  if (!selector1) {
    throw new Error(`${capability}: version1 is required ("current", a revision label, or a 1-based list position).`)
  }
  const selector2 = input.version2 !== undefined && String(input.version2).trim() !== ''
    ? String(input.version2).trim()
    : 'current'

  const { objectUri, revisionList } = await resolveObjectAndRevisions(client, capability, rawKind, objectName)

  // 选择器解析：current → 当前源码；其余走版本清单
  const readSelector = async (selector: string): Promise<{ source: string; label: string; meta?: { version: string; date?: string; author?: string } }> => {
    if (selector.toLowerCase() === 'current') {
      const source = await readCurrentSource(client, rawKind, objectName, objectUri)
      return { source, label: 'current' }
    }
    const entry = selectRevision(revisionList, selector)
    if (!entry) {
      throw new Error(
        `${capability}: revision "${selector}" was not found for ${objectName}`
        + (revisionList.length > 0
          ? ` (available: ${revisionList.map(e => String(e.version || e.versionTitle)).slice(0, 5).join(', ')}${revisionList.length > 5 ? ', ...' : ''})`
          : ' (no revisions listed)')
      )
    }
    const source = await client.getObjectSource(entry.uri)
    return {
      source,
      label: String(entry.version || entry.versionTitle || ''),
      meta: {
        version: String(entry.version ?? ''),
        ...(entry.date ? { date: String(entry.date) } : {}),
        ...(entry.author ? { author: String(entry.author) } : {})
      }
    }
  }

  const side1 = await readSelector(selector1)
  const side2 = await readSelector(selector2)
  const label1 = `${rawKind}:${objectName}@${side1.label}`
  const label2 = `${rawKind}:${objectName}@${side2.label}`

  if (side1.source === side2.source) {
    return {
      objectType: rawKind,
      objectName,
      label1,
      label2,
      identical: true,
      diff: 'Sources are identical',
      addedLines: 0,
      removedLines: 0,
      ...(side1.meta ? { revision1: side1.meta } : {}),
      ...(side2.meta ? { revision2: side2.meta } : {})
    }
  }

  const { diff, addedLines, removedLines } = unifiedDiff(label1, label2, side1.source, side2.source)
  return {
    objectType: rawKind,
    objectName,
    label1,
    label2,
    identical: false,
    diff,
    addedLines,
    removedLines,
    ...(side1.meta ? { revision1: side1.meta } : {}),
    ...(side2.meta ? { revision2: side2.meta } : {})
  }
}

/* ==========================================================================
 * 对象间源码对比（crud.compare-source；VSP CompareSource，pkg/adt/
 * workflows_source.go L1403-1444 的移植：两对象各自取当前源码 → identical
 * 判定 → unified diff → 增删行计数）
 * ========================================================================== */

/** compareSourceObjects 的输入。 */
export interface CompareSourceObjectsInput {
  /** 基准对象类型。 */
  objectType1: RevisionSourceKind
  /** 基准对象名。 */
  objectName1: string
  /** 对比对象类型。 */
  objectType2: RevisionSourceKind
  /** 对比对象名。 */
  objectName2: string
}

/** compareSourceObjects 的返回（对齐 VSP SourceDiff）。 */
export interface CompareSourceObjectsResult {
  objectType1: RevisionSourceKind
  objectName1: string
  objectType2: RevisionSourceKind
  objectName2: string
  /** 基准对象标注（TYPE1:NAME1）。 */
  label1: string
  /** 对比对象标注（TYPE2:NAME2）。 */
  label2: string
  /** 两份源码是否逐字节相同。 */
  identical: boolean
  /** unified diff 文本（identical 时为说明文字）。 */
  diff: string
  addedLines: number
  removedLines: number
  lines1: number
  lines2: number
}

/**
 * 对比两个对象的当前源码（只读）：各自经 quick search 精确解析源 URL 后
 * GET，LCS unified diff（3 行上下文）+ 增删行计数。
 */
export async function compareSourceObjects(
  client: RevisionSourceCapability,
  input: CompareSourceObjectsInput
): Promise<CompareSourceObjectsResult> {
  const capability = 'compareSourceObjects'
  if (!input || typeof input !== 'object') {
    throw new Error(`${capability}: input object is required.`)
  }
  const kind1 = String(input.objectType1 ?? '').trim().toUpperCase() as RevisionSourceKind
  const kind2 = String(input.objectType2 ?? '').trim().toUpperCase() as RevisionSourceKind
  // 名字白名单（与 getRevisionSource 同口径）：注入样本在进入 quick search 前拒绝
  const name1 = normalizeRepositoryName(input.objectName1, `${capability}.objectName1`)
  const name2 = normalizeRepositoryName(input.objectName2, `${capability}.objectName2`)
  for (const [label, kind, name] of [
    ['objectType1', kind1, name1],
    ['objectType2', kind2, name2]
  ] as const) {
    if (kind !== 'CLAS' && kind !== 'INTF' && kind !== 'FUNC' && kind !== 'PROG') {
      throw new Error(`${capability}: ${label} must be one of CLAS, INTF, FUNC, PROG.`)
    }
    if (!name) {
      throw new Error(`${capability}: ${label.replace('objectType', 'objectName')} is required.`)
    }
  }

  // 两侧源码各自解析读取（串行；同对象自比也允许）
  const url1 = await resolveObjectSourceUrl(client, kind1, name1, capability)
  const source1 = await client.getObjectSource(url1)
  const url2 = await resolveObjectSourceUrl(client, kind2, name2, capability)
  const source2 = await client.getObjectSource(url2)

  const label1 = `${kind1}:${name1}`
  const label2 = `${kind2}:${name2}`

  if (source1 === source2) {
    return {
      objectType1: kind1,
      objectName1: name1,
      objectType2: kind2,
      objectName2: name2,
      label1,
      label2,
      identical: true,
      diff: 'Sources are identical',
      addedLines: 0,
      removedLines: 0,
      lines1: source1.split('\n').length,
      lines2: source2.split('\n').length
    }
  }

  const { diff, addedLines, removedLines } = unifiedDiff(label1, label2, source1, source2)
  return {
    objectType1: kind1,
    objectName1: name1,
    objectType2: kind2,
    objectName2: name2,
    label1,
    label2,
    identical: false,
    diff,
    addedLines,
    removedLines,
    lines1: source1.split('\n').length,
    lines2: source2.split('\n').length
  }
}
