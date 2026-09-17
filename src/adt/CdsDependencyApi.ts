import type { AdtHTTP } from './AdtHTTP'
import { fullParse, xmlArray, xmlNodeAttr, xmlRoot } from './utilities'

/**
 * ============================================================================
 * CDS 依赖只读 ADT API（关闭能力矩阵缺口 read.cds-analysis）
 * ============================================================================
 *
 * 本文件提供三个纯只读的 CDS 分析能力（对齐 VSP vibing-steampunk 的
 * CDS_DEPS / CDS_IMPACT / CDS_ELEMENTS 三个 SAP read 任务）：
 *
 *   1. getCdsDependencies   —— CDS 依赖树（上游依赖：该 CDS 从哪些表/视图读取）
 *   2. getCdsImpactAnalysis —— CDS 反向影响（下游受影响对象：谁在消费该 CDS）
 *   3. getCdsElementInfo    —— CDS 元素元数据（视图字段/元素清单）
 *
 * 端点与协议逐一对齐 VSP 上游实现（来源在各自函数注释中注明），解析结果
 * 统一裁剪为精简 JSON（对象名/类型/URI/依赖方向等最小可用集合），绝不向
 * 调用方返回原始 XML 响应体。
 *
 * 设计规则（业务约束）：
 *   - 三个函数全部只读（HTTP GET 或无副作用的 usageReferences 查询 POST），
 *     不涉及任何 SAP 写操作、锁、传输或激活。
 *   - 输入只接受 objectType+objectName（对齐本项目 read 工具习惯）；
 *     ADT URI 一律由对象名在服务端推导，绝不接受调用方传入的任意 URL
 *     （本项目安全边界：不接受任意 URL/XML/lock handle）。
 *   - VSP 的 CDS_DEPS 处理器虽然接受 dependency_level / with_associations /
 *     context_package 三个参数，但其底层实现（pkg/adt/cds.go）完全未把它们
 *     拼进端点请求；为避免对外承诺无效参数，这里刻意不暴露这些输入。
 *   - 解析层容错对齐 VSP：XML 结构不符合预期时返回空结果而非抛错
 *     （端点可能返回精简或空负载），只有 HTTP 层错误才向上传播。
 */

/** CDS 分析支持的 ADT 对象类型：目前仅 DDLS（CDS DDL 源）。 */
export type CdsAnalysisObjectType = 'DDLS'

/** 三个 CDS 只读分析能力共享的查询输入。 */
export interface CdsAnalysisQuery {
  /** CDS DDL 源对象名，例如 ZC_TRAVEL_U；内部统一规范为大写。 */
  objectName: string
  /** 对象类型；缺省即 DDLS，显式传入其他类型会被拒绝。 */
  objectType?: CdsAnalysisObjectType
}

/** 依赖树中的一个节点：name/type 必有，relation 标注依赖方向。 */
export interface CdsDependencyNode {
  /** 依赖对象名（表名、视图名或 CDS 实体名）。 */
  name: string
  /** 依赖对象的 ADT 技术类型，例如 TABLE / CDS_VIEW / STOB。 */
  type: string
  /** 依赖方向标注：本端点返回的均为 FROM（当前 CDS 从该对象读取）。 */
  relation: string
  /** 嵌套子依赖；doubledata 端点通常只有一层，解析层仍支持递归结构。 */
  children?: CdsDependencyNode[]
}

/** getCdsDependencies 的返回：精简依赖树 + 统计信息。 */
export interface CdsDependencyTreeResult {
  /** 规范化（大写）后的查询对象名。 */
  objectName: string
  /** 语义标注：本结果描述的是上游依赖（该 CDS 从哪些对象读取）。 */
  direction: 'upstream'
  /** 依赖树根节点，即被分析的 CDS 视图本身。 */
  root: { name: string; type: string }
  /** 展平后的全部依赖（不含根节点自身），便于直接列表展示。 */
  dependencies: CdsDependencyNode[]
  /** 统计摘要：total=依赖总数（不含根），tableCount=其中表依赖数，
   *  depth=树深度（仅根时为 1，对齐 VSP GetDependencyDepth 语义），
   *  byType=按依赖类型分组的数量。 */
  statistics: {
    total: number
    tableCount: number
    depth: number
    byType: Record<string, number>
  }
}

/** 反向影响分析命中的单个下游对象。 */
export interface CdsImpactedObject {
  /** 消费该 CDS 的对象名。 */
  name: string
  /** 消费对象的 ADT 类型，例如 CLAS/CLASS、DDLS/DDLS 等。 */
  type: string
  /** 消费对象的 ADT URI（由 SAP 返回，非调用方输入）。 */
  uri: string
  /** 对象描述（SAP 未返回时省略该字段）。 */
  description?: string
  /** 对象所属开发包（SAP 未返回时省略该字段）。 */
  packageRef?: string
}

/** getCdsImpactAnalysis 的返回：下游受影响对象清单。 */
export interface CdsImpactAnalysisResult {
  /** 规范化（大写）后的查询对象名。 */
  objectName: string
  /** 语义标注：本结果描述的是下游影响（谁在消费该 CDS）。 */
  direction: 'downstream'
  /** 下游消费对象列表。 */
  impactedObjects: CdsImpactedObject[]
  /** 与 impactedObjects 长度一致的便利计数。 */
  totalCount: number
}

/** CDS 视图中单个元素（字段）的元数据。 */
export interface CdsElementInfo {
  /** 元素名（字段名）。 */
  name: string
  /** 元素 ABAP/DDIC 类型（SAP 未返回时省略）。 */
  type?: string
  /** 元素描述（SAP 未返回时省略）。 */
  description?: string
  /** 语义标注，例如 key / semanticKey（SAP 未返回时省略）。 */
  semantics?: string
  /** 元素上的 CDS 注解名值对（无注解时省略）。 */
  annotations?: Record<string, string>
}

/** getCdsElementInfo 的返回：CDS 视图字段清单。 */
export interface CdsElementInfoResult {
  /** 规范化（大写）后的查询对象名。 */
  objectName: string
  /** SAP 响应中回读的视图名（与 objectName 基本一致，保留以利核对）。 */
  viewName: string
  /** 元素（字段）清单；无元素时为空数组而非 undefined。 */
  elements: CdsElementInfo[]
  /**
   * 降级说明（可选）：目标系统不支持 v2 结构化端点（仅回退到老版
   * ddlSource 表示，其中不含元素清单）时，说明原因，避免调用方把
   * 空清单误读为“该 CDS 没有字段”。
   */
  note?: string
}

/**
 * 规范化 CDS DDL 源对象名：
 * - 去除首尾空白并统一转大写（SAP 对象名大小写不敏感，统一大写便于断言与缓存）；
 * - 业务规则：非空、最长 40 字符（DDLS 名称上限 30，留出 CL/命名空间余量）、
 *   不允许空白与控制字符，保证拼入 URL 的安全性。
 * 超出规则直接抛错，绝不静默截断。
 */
function normalizeCdsObjectName(value: unknown, capability: string): string {
  const name = String(value ?? '').trim().toUpperCase()
  if (!name || name.length > 40 || /[\s\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(
      `${capability}: objectName must be a non-empty CDS DDL source name of at most 40 characters without whitespace or control characters.`
    )
  }
  return name
}

/**
 * 解析响应前统一做"去命名空间 + 容错"的 XML 解析。
 * ADT 各端点对命名空间前缀（adtcore:、usageReferences:、ddl: 等）的使用随版本
 * 漂移，removeNSPrefix 后按本地名取节点，与 VSP 在解析前做字符串前缀清理等效；
 * 解析失败时返回 undefined，由调用方按"空结果"处理（对齐 VSP 容错语义）。
 */
function parseAdtXmlLenient(body: string): any {
  try {
    return fullParse(body, { removeNSPrefix: true })
  } catch {
    return undefined
  }
}

/* ==========================================================================
 * 1. CDS 依赖树（上游依赖）
 * ==========================================================================
 * VSP 来源：pkg/adt/cds.go 的 GetCDSDependencies（handler: internal/mcp/
 * handlers_read.go case "CDS_DEPS" / handleGetCDSDependencies）。
 *
 * ADT 端点（VSP cds.go 第 42-51 行注释指明）：
 *   GET /sap/bc/adt/testcodegen/dependencies/doubledata?ddlsourceName=<CDS名>
 *   Accept: application/vnd.sap.adt.codegen.data.v1+xml
 * 该端点本为测试替身（test double）代码生成设计，返回 CDS 视图读取的全部
 * 表/视图依赖，是各系统上可稳定获得 CDS 上游依赖的端点（VSP 注释说明
 * /sap/bc/adt/cds/dependencies 之类端点并非所有系统都存在，故不采用）。
 *
 * 响应结构（按本地名）：
 *   <...>
 *     <cdsundertest cds_name="ZC_TRAVEL_U">
 *       <doublelist>
 *         <double double_name="/DMO/I_TRAVEL" double_type="TABLE"/>
 *         ...
 *       </doublelist>
 *     </cdsundertest>
 *   </...>
 * 外层包装元素名随系统版本漂移，因此按深度 <=2 搜索 cdsundertest 节点
 * （等价于 Go xml.Unmarshal 按结构匹配任意深度的行为）。
 */
export async function getCdsDependencies(
  h: AdtHTTP,
  input: CdsAnalysisQuery
): Promise<CdsDependencyTreeResult> {
  // 名字规范化失败（空/超长/含控制字符）会在请求发出前抛错
  const objectName = normalizeCdsObjectName(input?.objectName, 'getCdsDependencies')

  const response = await h.request(
    `/sap/bc/adt/testcodegen/dependencies/doubledata?ddlsourceName=${encodeURIComponent(objectName)}`,
    {
      method: 'GET',
      headers: { Accept: 'application/vnd.sap.adt.codegen.data.v1+xml' }
    }
  )

  try {
    return parseCdsDependencyTree(response.body, objectName)
  } catch (error) {
    // 包装 HTTP/解析错误上下文，便于上层定位是哪个能力失败（对齐 VSP wrap 风格）
    throw new Error(
      `failed to get CDS dependencies: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 将 doubledata 端点的 XML 响应解析为精简依赖树结果。
 * - 递归解析 double 节点（支持 doublelist>double 嵌套），统一标注 relation=FROM；
 * - 统计口径对齐 VSP handleGetCDSDependencies 的 summary：total 为展平依赖数
 *   （不含根），byType 按依赖类型计数，tableCount 只数 type=TABLE 的依赖，
 *   depth 对齐 VSP GetDependencyDepth：仅根为 1，每深一层 +1。
 */
function parseCdsDependencyTree(body: string, objectName: string): CdsDependencyTreeResult {
  const raw = parseAdtXmlLenient(body)
  const underTest = findCdsUnderTest(raw)

  // 根节点：cdsundertest 的 cds_name 属性；缺失时回退为查询对象名
  const rootAttr = xmlNodeAttr(underTest)
  const root: { name: string; type: string } = {
    name: String(rootAttr?.cds_name || objectName),
    type: 'CDS_VIEW'
  }

  // doublelist>double 可能单值或数组（xmlArray 统一处理），逐个递归解析
  const children = xmlArray<any>(underTest?.doublelist, 'double').map(parseDoubleNode)

  // 展平全部子孙依赖（不含根），统计 byType / 表依赖
  const dependencies = children.flatMap(flattenDependencyNodes)
  const byType: Record<string, number> = {}
  for (const dep of dependencies) {
    byType[dep.type] = (byType[dep.type] || 0) + 1
  }

  return {
    objectName,
    direction: 'upstream',
    root,
    dependencies,
    statistics: {
      total: dependencies.length,
      tableCount: dependencies.filter(dep => dep.type === 'TABLE').length,
      depth: dependencyDepth({ children }),
      byType
    }
  }
}

/** 在解析结果中按深度 <=2 查找 cdsundertest 节点（外层包装名不定）。 */
function findCdsUnderTest(raw: any): any {
  if (!raw || typeof raw !== 'object') return undefined
  if (raw.cdsundertest) return raw.cdsundertest
  for (const key of Object.keys(raw)) {
    const child = raw[key]
    if (child && typeof child === 'object' && child.cdsundertest) return child.cdsundertest
  }
  return undefined
}

/** 递归解析单个 double 节点；relation 固定 FROM（上游读取来源）。 */
function parseDoubleNode(node: any): CdsDependencyNode {
  const attr = xmlNodeAttr(node)
  // children 仅在端点确实返回嵌套依赖时输出，避免给调用方塞一堆空数组
  const children = xmlArray<any>(node?.doublelist, 'double').map(parseDoubleNode)
  return {
    name: String(attr?.double_name || ''),
    type: String(attr?.double_type || ''),
    relation: 'FROM',
    ...(children.length > 0 ? { children } : {})
  }
}

/** 展平依赖节点及其全部子孙（不含调用方已计入的父节点本身）。 */
function flattenDependencyNodes(node: CdsDependencyNode): CdsDependencyNode[] {
  return [node, ...(node.children || []).flatMap(flattenDependencyNodes)]
}

/** 树深度：叶节点为 1，父节点为 1 + 最深子树（对齐 VSP GetDependencyDepth）。 */
function dependencyDepth(node: { children?: CdsDependencyNode[] }): number {
  if (!node.children || node.children.length === 0) return 1
  return 1 + Math.max(...node.children.map(dependencyDepth))
}

/* ==========================================================================
 * 2. CDS 反向影响分析（下游受影响对象）
 * ==========================================================================
 * VSP 来源：pkg/adt/cds_tools.go 的 GetCDSImpactAnalysis（handler:
 * internal/mcp/handlers_cds.go handleGetCDSImpactAnalysis；
 * universal 入口 internal/mcp/handlers_read.go case "CDS_IMPACT"）。
 *
 * ADT 端点（VSP cds_tools.go 第 40-56 行）：
 *   POST /sap/bc/adt/repository/informationsystem/usageReferences?uri=<对象URI>
 *   对象 URI 由服务端推导：/sap/bc/adt/ddic/ddl/sources/<大写CDS名>
 *   Content-Type: application/*   Accept: application/*
 *   请求体：usageReferenceRequest（ris/usageReferences 命名空间，空 affectedObjects）
 * 这是 ADT where-used（usage references）API，返回全部消费/引用该 CDS 的
 * 下游对象；响应里 isResult="true" 的条目才是命中结果（其余为导航上下文）。
 */
export async function getCdsImpactAnalysis(
  h: AdtHTTP,
  input: CdsAnalysisQuery
): Promise<CdsImpactAnalysisResult> {
  const objectName = normalizeCdsObjectName(input?.objectName, 'getCdsImpactAnalysis')

  // 由对象名推导 CDS DDL 源 URI（绝不接受调用方传入的任意 URI）
  const objectUri = `/sap/bc/adt/ddic/ddl/sources/${encodeURIComponent(objectName)}`
  // 请求体逐字对齐 VSP：命名空间 http://www.sap.com/adt/ris/usageReferences，
  // 空 affectedObjects 表示"以 uri 参数指向的对象为影响分析起点"
  const body = `<?xml version="1.0" encoding="ASCII"?>
<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">
  <usagereferences:affectedObjects/>
</usagereferences:usageReferenceRequest>`

  const response = await h.request(
    `/sap/bc/adt/repository/informationsystem/usageReferences?uri=${encodeURIComponent(objectUri)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/*', Accept: 'application/*' },
      body
    }
  )

  try {
    return parseCdsImpactAnalysis(response.body, objectName)
  } catch (error) {
    throw new Error(
      `CDS impact analysis failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 解析 usageReferenceResult XML 为下游影响清单。
 * 只保留 referencedObject 的 isResult="true" 条目（SAP 会附带非命中的
 * 导航上下文对象）；每条裁剪为 name/type/uri + 可选 description/packageRef。
 * 结构意外（空/版本差异）时返回空清单，不抛错（对齐 VSP parseCDSImpactAnalysis
 * 对 unmarshal 失败返回空结果的容错语义）。
 */
function parseCdsImpactAnalysis(body: string, objectName: string): CdsImpactAnalysisResult {
  const raw = parseAdtXmlLenient(body)
  // 根节点 usageReferenceResult；容错回退 xmlRoot（应对根名带未知前缀的场景）
  const resultNode = raw?.usageReferenceResult ?? xmlRoot(raw)
  const referenced = xmlArray<any>(resultNode?.referencedObjects, 'referencedObject')

  const impactedObjects: CdsImpactedObject[] = []
  for (const entry of referenced) {
    // isResult 经 parseAttributeValue 解析后为布尔；兼容字符串 "true" 的版本差异
    const isResult = entry?.['@_isResult']
    if (isResult !== true && isResult !== 'true') continue

    const objectAttr = xmlNodeAttr(entry?.adtObject)
    const packageAttr = xmlNodeAttr(entry?.adtObject?.packageRef)
    impactedObjects.push({
      name: String(objectAttr?.name || ''),
      type: String(objectAttr?.type || ''),
      uri: String(objectAttr?.uri || entry?.['@_uri'] || ''),
      ...(objectAttr?.description ? { description: String(objectAttr.description) } : {}),
      ...(packageAttr?.name ? { packageRef: String(packageAttr.name) } : {})
    })
  }

  return {
    objectName,
    direction: 'downstream',
    impactedObjects,
    totalCount: impactedObjects.length
  }
}

/* ==========================================================================
 * 3. CDS 元素元数据（字段/元素清单）
 * ==========================================================================
 * VSP 来源：pkg/adt/cds_tools.go 的 GetCDSElementInfo（handler:
 * internal/mcp/handlers_cds.go handleGetCDSElementInfo；
 * universal 入口 internal/mcp/handlers_read.go case "CDS_ELEMENTS"）。
 *
 * ADT 端点（VSP cds_tools.go 第 146-152 行）：
 *   GET /sap/bc/adt/ddic/ddl/sources/<大写CDS名>
 *   Accept: application/vnd.sap.adt.ddic.ddlsources.v2+xml（v2 结构化，含元素清单）
 *   回退：application/vnd.sap.adt.ddlSource+xml（老版元数据表示，无元素清单；
 *         真机 DEV 实测该系统未注册 v2 类型，VSP 上游同样不可用，见实现内注释）
 * 以结构化 XML（而非源码文本）读取 DDL 源元数据，包含 content>element 的
 * 字段名/类型/描述/语义标注及 annotation 子节点。
 */
export async function getCdsElementInfo(
  h: AdtHTTP,
  input: CdsAnalysisQuery
): Promise<CdsElementInfoResult> {
  const objectName = normalizeCdsObjectName(input?.objectName, 'getCdsElementInfo')

  // v2 结构化端点优先（含 content>element 元数据）；部分 ADT 系统版本未注册
  // v2 类型，只接受老版 ddlSource 表示（真机 DEV 系统实测：返回 406 语义的
  // “message content is not acceptable”，且 VSP 上游同样只发 v2、在此类系统
  // 不可用）。此处对“内容不可接受”回退到老类型重试一次：老表示无元素清单，
  // 解析后返回空 elements 并附 note，保证工具在老系统可用且结果不被误读。
  let body: string
  let degraded = false
  try {
    body = await requestCdsElementInfo(h, objectName, 'application/vnd.sap.adt.ddic.ddlsources.v2+xml')
  } catch (v2Error) {
    const v2Message = v2Error instanceof Error ? v2Error.message : String(v2Error)
    if (!/not acceptable/i.test(v2Message)) {
      // 非“内容不可接受”的上游错误（403/网络等）原样传播，不包装、不吞掉
      throw v2Error
    }
    body = await requestCdsElementInfo(h, objectName, 'application/vnd.sap.adt.ddlSource+xml')
    degraded = true
  }

  try {
    const parsed = parseCdsElementInfo(body, objectName)
    if (degraded && parsed.elements.length === 0) {
      parsed.note = 'Target system does not expose the structured ddlsources.v2 representation; element list is unavailable (legacy ddlSource representation carries metadata only).'
    }
    return parsed
  } catch (error) {
    throw new Error(
      `CDS element info failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** 以指定 Accept 类型请求 DDL 源表示（v2 结构化或老版元数据）。 */
async function requestCdsElementInfo(h: AdtHTTP, objectName: string, accept: string): Promise<string> {
  const response = await h.request(`/sap/bc/adt/ddic/ddl/sources/${encodeURIComponent(objectName)}`, {
    method: 'GET',
    headers: { Accept: accept }
  })
  return response.body
}

/**
 * 解析 ddlsources.v2 结构化元数据为字段清单。
 * 主结构：ddlSource > content > element（name/type/description/semantics 属性 +
 * annotation 子节点）；部分 ADT 版本返回扁平的 ddlSource > field，作为回退结构。
 * 两个结构都不匹配时返回空元素清单，不抛错（对齐 VSP parseCDSElementInfo 的
 * 双结构尝试 + 最终空结果语义）。
 */
function parseCdsElementInfo(body: string, objectName: string): CdsElementInfoResult {
  const raw = parseAdtXmlLenient(body)
  const ddlSource = raw?.ddlSource ?? xmlRoot(raw)
  const sourceAttr = xmlNodeAttr(ddlSource)

  // 主结构：content 下挂 element；content 自身可能是数组，逐个展开
  const elementNodes = xmlArray<any>(ddlSource?.content, 'element')
  // 回退结构：老版本 ADT 直接在根下挂 field 元素
  const fieldNodes = elementNodes.length === 0 ? xmlArray<any>(ddlSource, 'field') : []
  const nodes = elementNodes.length > 0 ? elementNodes : fieldNodes

  const elements: CdsElementInfo[] = nodes.map(node => {
    const attr = xmlNodeAttr(node)
    // 注解子节点收敛为名值对象；无注解时保持字段缺省（精简输出）
    const annotations: Record<string, string> = {}
    for (const annotation of xmlArray<any>(node, 'annotation')) {
      const annoAttr = xmlNodeAttr(annotation)
      if (annoAttr?.name) annotations[String(annoAttr.name)] = String(annoAttr.value ?? '')
    }
    return {
      name: String(attr?.name || ''),
      ...(attr?.type ? { type: String(attr.type) } : {}),
      ...(attr?.description ? { description: String(attr.description) } : {}),
      ...(attr?.semantics ? { semantics: String(attr.semantics) } : {}),
      ...(Object.keys(annotations).length > 0 ? { annotations } : {})
    }
  })

  return {
    objectName,
    // SAP 未回读视图名时回退为查询对象名，保证结果可独立解读
    viewName: String(sourceAttr?.name || objectName),
    elements
  }
}

/* ==========================================================================
 * 客户端绑定（供后续集成任务接线的注入点）
 * ==========================================================================
 * 三个能力共享的窄接口；CdsAnalysisHandlers（src/handlers/CdsAnalysisHandlers.ts）
 * 以此为构造注入边界，便于 mock 与按 profile 装配。
 */
export interface CdsAnalysisClient {
  getCdsDependencies(input: CdsAnalysisQuery): Promise<CdsDependencyTreeResult>
  getCdsImpactAnalysis(input: CdsAnalysisQuery): Promise<CdsImpactAnalysisResult>
  getCdsElementInfo(input: CdsAnalysisQuery): Promise<CdsElementInfoResult>
}

/**
 * 把 AdtHTTP 会话绑定成 CdsAnalysisClient。
 * 集成任务接线方式：createCdsAnalysisClient(client.h)（AdtClient 通过公开
 * getter `h` 暴露内部 AdtHTTP 会话）；本任务不改动 AdtClient/index 接线。
 */
export function createCdsAnalysisClient(h: AdtHTTP): CdsAnalysisClient {
  return {
    getCdsDependencies: input => getCdsDependencies(h, input),
    getCdsImpactAnalysis: input => getCdsImpactAnalysis(h, input),
    getCdsElementInfo: input => getCdsElementInfo(h, input)
  }
}
