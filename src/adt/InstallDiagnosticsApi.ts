/**
 * ============================================================================
 * 安装前置只读发现 API（关闭能力矩阵缺口 install.diagnostics 的
 * helper 前置检查部分）
 * ============================================================================
 *
 * 回答"如果要在该 SAP 系统上运行 helper（ZADT_VSP）或使用 abapGit，前置条件
 * 现状如何"——纯只读 discovery，不做任何安装动作（安装属矩阵
 * INTENTIONAL_RESTRICTION 行：install.zadt-vsp/install.abapgit/deploy-zip）。
 * 对齐 VSP vibing-steampunk 的 system FEATURES + focused ListDependencies 的
 * "前置现状发现"语义（internal/mcp/handlers_install.go L464-489 的清单精神、
 * handlers_system.go FEATURES），但依赖清单本身是 VSP 的本地嵌入 ZIP（安装
 * 动作的输入），对本项目不适用——本实现探测的是 SAP 端与本地运行时的实际
 * 现状。
 *
 * 探测项：
 *   1. ZADT_VSP helper：TADIR 模糊查 ZADT_VSP%（PGMID='R3TR'）——本项目不
 *      依赖 helper，安装也属排除方向，此处仅报告现状。F2 交接深化：
 *      a) 激活状态核验——CLAS/INTF 查 SEOCLSRC.STATE、PROG/FUGR 查
 *         REPOSRC.R3STATE（均只读 SQL，失败降级 UNKNOWN 不中断）；
 *      b) APC/SICF WebSocket 服务面探测——GET /sap/bc/apc/sap/zadt_vsp，
 *         404/资源不存在=未配置，其他状态=服务面存在；
 *      c) 人可读就绪结论 readiness（ready/not_installed/inactive_objects/
 *         service_face_missing/unknown）；
 *   2. abapGit：GET /sap/bc/adt/abapgit/repos（abapGit 的 ADT 服务根）——200 可
 *      用；404 未安装；403 已装但当前用户无权限；其他为错误。
 *
 * 业务规则：
 *   - 全部只读（SELECT/GET）；任何探测失败都不中断整体报告（分类进对应
 *     状态或 error 字段）。
 *   - 本地运行时只报 Node 版本（本项目唯一的"本地依赖"）。
 */

/**
 * WebSocket 服务面探测结果（F2 交接深化）：
 * GET /sap/bc/apc/sap/zadt_vsp 区分"对象在但服务面未配"与"完全可用"。
 */
export interface HelperServiceFace {
  /** APC ICF 节点的 HTTP 状态码（探测异常时为 0）。 */
  status: number
  /** configured=服务面存在（非 404 均算，400/401/405 等只说明探测请求不是 WebSocket 升级）；not_configured=404/资源不存在；unknown=连接级失败。 */
  state: 'configured' | 'not_configured' | 'unknown'
  detail: string
}

/** 对象激活状态结论（F2 交接深化：TADIR 存在性 → 按类型的 active 版本核验）。 */
export interface HelperActivation {
  /** 激活状态核验是否成功执行（SQL 通道失败时为 false，状态保持 UNKNOWN）。 */
  verified: boolean
  /** 已确认存在 active 版本的对象数。 */
  activeCount: number
  /** 未能确认 active 的对象（state=INACTIVE 仅存在非激活版本 / UNKNOWN=核验失败或类型不支持）。 */
  notActive: Array<{ name: string; type: string; state: 'INACTIVE' | 'UNKNOWN' }>
}

/** 人可读的就绪结论（F2 验收口径）。 */
export interface HelperReadiness {
  /** ready=对象全激活且 WebSocket 服务面已配置；not_installed/inactive_objects/service_face_missing/unknown 分级报告。 */
  state: 'ready' | 'not_installed' | 'inactive_objects' | 'service_face_missing' | 'unknown'
  detail: string
}

/** ZADT_VSP helper 发现结果。 */
export interface HelperDiscovery {
  /** 是否发现 helper 对象（TADIR 有 ZADT_VSP% 记录）。 */
  installed: boolean
  /** 发现的 helper 对象（OBJ_NAME + OBJECT 类型）。 */
  objects: Array<{ name: string; type: string }>
  /** 激活状态核验（成功时必有）。 */
  activation?: HelperActivation
  /** APC/SICF WebSocket 服务面探测（installed 时执行）。 */
  serviceFace?: HelperServiceFace
  /** 人可读结论：如"对象 10/10 激活，WebSocket 服务面未配置：SAPC/SICF 待做"。 */
  readiness?: HelperReadiness
  /** TADIR 探测失败的原因（成功时缺失）。 */
  detail?: string
}

/** abapGit 可用性发现结果。 */
export interface AbapGitDiscovery {
  /** available=服务可达；not_installed=404；forbidden=403；error=其他。 */
  status: 'available' | 'not_installed' | 'forbidden' | 'error'
  detail: string
}

/** checkInstallPrerequisites 的返回。 */
export interface InstallPrerequisitesResult {
  /** Node 运行时版本（本地依赖现状）。 */
  localRuntime: { node: string }
  zadtVspHelper: HelperDiscovery
  abapGit: AbapGitDiscovery
  /** 边界说明：本项目不做任何自动安装。 */
  notes: string[]
}

/** 项目 ADT 客户端最小结构视图。 */
export interface InstallDiagnosticsCapability {
  searchObject(query: string, objType?: string, max?: number): Promise<Array<Record<string, any>>>
  runQuery(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>
  /**
   * GET abapGit ADT 服务根（/sap/bc/adt/abapgit/repos）。200 时返回 {status: 200}；
   * 4xx/5xx 由底层抛出带 status 的异常（AdtException.status），由本 API 的
   * catch 分类（404=未安装、403=无权限、其他=error）。
   */
  requestGitRepos(): Promise<{ status: number }>
  /**
   * F2 交接深化：GET APC WebSocket 服务面（/sap/bc/apc/sap/zadt_vsp）。
   * 404/资源不存在 = SICF 节点未创建或未激活；其他状态（400/401/405/426 等）
   * 证明服务面存在——APC handler 对非 WebSocket 升级请求本来就不会回 200。
   */
  requestApcService(): Promise<{ status: number }>
}

/** 单元格容错字符串化。 */
function cell(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** 瞬时失败重试一次的 runQuery（该 DEV datapreview 存在瞬时 500）。 */
async function queryWithRetry(client: InstallDiagnosticsCapability, sql: string, limit = 50): Promise<Record<string, unknown>[]> {
  try {
    return (await client.runQuery(sql, limit)).values ?? []
  } catch {
    return (await client.runQuery(sql, limit)).values ?? []
  }
}

/**
 * 按类型核验对象激活状态（只读 SQL，失败不中断——整体结论降级 UNKNOWN）：
 * - CLAS/INTF：SEOCLSRC.STATE（'A'=激活版本存在）；
 * - PROG/FUGR：REPOSRC.R3STATE='A'；
 * - 其他类型：状态无通用只读表，标 UNKNOWN 并在结论中如实说明。
 */
async function probeActivation(
  client: InstallDiagnosticsCapability,
  objects: Array<{ name: string; type: string }>
): Promise<HelperActivation> {
  const activation: HelperActivation = { verified: false, activeCount: 0, notActive: [] }
  const classNames = objects.filter(o => o.type === 'CLAS' || o.type === 'INTF').map(o => o.name)
  const progNames = objects.filter(o => o.type === 'PROG' || o.type === 'FUGR').map(o => o.name)
  const otherNames = objects.filter(o => o.type !== 'CLAS' && o.type !== 'INTF' && o.type !== 'PROG' && o.type !== 'FUGR')

  const activeNames = new Set<string>()
  let anyQuerySucceeded = false
  try {
    if (classNames.length > 0) {
      // SEOCLSRC：类/接口源按 STATE 分版本（A=active / I=inactive）
      const rows = await queryWithRetry(client, "SELECT clsname, state FROM seoclsrc WHERE clsname LIKE 'ZADT_VSP%'")
      anyQuerySucceeded = true
      for (const row of rows) {
        if (cell(row, 'STATE').toUpperCase() === 'A') activeNames.add(cell(row, 'CLSNAM').toUpperCase())
      }
    }
    if (progNames.length > 0) {
      const rows = await queryWithRetry(client, "SELECT progname, r3state FROM reposrc WHERE progname LIKE 'ZADT_VSP%'")
      anyQuerySucceeded = true
      for (const row of rows) {
        if (cell(row, 'R3STATE').toUpperCase() === 'A') activeNames.add(cell(row, 'PROGNAME').toUpperCase())
      }
    }
  } catch {
    // 任一激活表不可读：整体降级为"未核验"，与 TADIR-only 的旧行为一致但在 notes 说明
    return { verified: false, activeCount: 0, notActive: objects.map(o => ({ name: o.name, type: o.type, state: 'UNKNOWN' as const })) }
  }

  activation.verified = anyQuerySucceeded
  for (const object of objects) {
    if (activeNames.has(object.name.toUpperCase())) {
      activation.activeCount += 1
    } else if (!anyQuerySucceeded || otherNames.some(other => other.name === object.name)) {
      activation.notActive.push({ name: object.name, type: object.type, state: 'UNKNOWN' })
    } else {
      activation.notActive.push({ name: object.name, type: object.type, state: 'INACTIVE' })
    }
  }
  return activation
}

/**
 * APC/SICF WebSocket 服务面探测（只读 GET）。
 * 404 或"资源不存在"= 未配置；任何其他 HTTP 状态 = 服务面存在（APC handler
 * 对普通 HTTP 请求本就不回 200，400/405/426 都是"在但不是 WebSocket 升级"）。
 */
async function probeServiceFace(client: InstallDiagnosticsCapability): Promise<HelperServiceFace> {
  const path = '/sap/bc/apc/sap/zadt_vsp'
  try {
    const response = await client.requestApcService()
    if (response.status === 404) {
      return { status: 404, state: 'not_configured', detail: `GET ${path} returned 404 (APC application or SICF node missing/inactive)` }
    }
    return {
      status: response.status,
      state: 'configured',
      detail: `GET ${path} returned ${response.status} (service face exists; plain GET is not a WebSocket upgrade)`
    }
  } catch (error) {
    const status = (error as { status?: unknown })?.status
    const message = error instanceof Error ? error.message : String(error)
    if (status === 404 || /\b404\b/.test(message) || /does not exist/i.test(message)) {
      return { status: typeof status === 'number' ? status : 404, state: 'not_configured', detail: `GET ${path} reported the resource does not exist (SAPC application / SICF node not configured)` }
    }
    if (typeof status === 'number' && status > 0) {
      return { status, state: 'configured', detail: `GET ${path} returned ${status} (service face exists)` }
    }
    return { status: 0, state: 'unknown', detail: `APC service probe failed: ${message}`.slice(0, 200) }
  }
}

/** 组装人可读就绪结论（F2 验收口径）。 */
function summarizeReadiness(
  installed: boolean,
  objectsCount: number,
  activation: HelperActivation | undefined,
  serviceFace: HelperServiceFace | undefined
): HelperReadiness {
  if (!installed) {
    return { state: 'not_installed', detail: 'ZADT_VSP helper objects are not present in TADIR (not installed on this system).' }
  }
  if (!activation?.verified) {
    return { state: 'unknown', detail: `Found ${objectsCount} helper object(s), but their activation state could not be verified (activation tables unreadable).` }
  }
  const inactive = activation.notActive.filter(entry => entry.state === 'INACTIVE')
  if (inactive.length > 0) {
    return {
      state: 'inactive_objects',
      detail: `Found ${objectsCount} helper object(s); ${activation.activeCount} active, ${inactive.length} NOT active (${inactive.map(entry => entry.name).join(', ')}). Activate them before use.`
    }
  }
  if (!serviceFace || serviceFace.state === 'unknown') {
    return { state: 'unknown', detail: `Objects ${activation.activeCount}/${objectsCount} active, but the WebSocket service face could not be probed.` }
  }
  if (serviceFace.state === 'not_configured') {
    return {
      state: 'service_face_missing',
      detail: `Objects ${activation.activeCount}/${objectsCount} active, WebSocket service face NOT configured: run transaction SAPC (create the APC application) and activate the SICF node /sap/bc/apc/sap/zadt_vsp.`
    }
  }
  return { state: 'ready', detail: `Objects ${activation.activeCount}/${objectsCount} active and the WebSocket service face is configured (helper ready).` }
}

/**
 * 安装前置只读发现（不安装任何东西；探测失败分类报告而不中断）。
 */
export async function checkInstallPrerequisites(
  client: InstallDiagnosticsCapability
): Promise<InstallPrerequisitesResult> {
  const notes = [
    'read-only discovery only: this server never installs helper objects (see install.* INTENTIONAL_RESTRICTION rows)'
  ]

  // 1) ZADT_VSP helper：TADIR 模糊查（查询失败重试 1 次——该 DEV datapreview
  //    存在瞬时 500；仍失败按"未知"处理，不中断）。F2 深化：清单之上再核验
  //    激活状态与 APC/SICF WebSocket 服务面，输出人可读就绪结论。
  const helper: HelperDiscovery = { installed: false, objects: [] }
  const tadirSql = "SELECT obj_name, object FROM tadir WHERE obj_name LIKE 'ZADT_VSP%'"
  try {
    const rows = await queryWithRetry(client, tadirSql)
    for (const row of rows) {
      const name = cell(row, 'OBJ_NAME')
      const type = cell(row, 'OBJECT')
      if (name) helper.objects.push({ name, type })
    }
    helper.installed = helper.objects.length > 0
    if (helper.installed) {
      helper.activation = await probeActivation(client, helper.objects)
      helper.serviceFace = await probeServiceFace(client)
    }
  } catch (error) {
    helper.detail = `TADIR probe failed: ${error instanceof Error ? error.message : String(error)}`
      .slice(0, 200)
  }
  helper.readiness = summarizeReadiness(helper.installed, helper.objects.length, helper.activation, helper.serviceFace)

  // 2) abapGit：GET /sap/bc/adt/abapgit/repos 按状态分类
  const abapGit: AbapGitDiscovery = { status: 'error', detail: '' }
  try {
    const response = await client.requestGitRepos()
    if (response.status === 200) {
      abapGit.status = 'available'
      abapGit.detail = 'GET /sap/bc/adt/abapgit/repos returned 200'
    } else if (response.status === 404) {
      abapGit.status = 'not_installed'
      abapGit.detail = 'GET /sap/bc/adt/abapgit/repos returned 404 (abapGit ADT service absent)'
    } else if (response.status === 403) {
      abapGit.status = 'forbidden'
      abapGit.detail = 'GET /sap/bc/adt/abapgit/repos returned 403 (installed, but the current user lacks authorization)'
    } else {
      abapGit.status = 'error'
      abapGit.detail = `GET /sap/bc/adt/abapgit/repos returned ${response.status}`
    }
  } catch (error) {
    // isHttpError 场景带 status；纯 Error 按错误分类并摘要在 detail
    const status = (error as { status?: unknown })?.status
    const message = error instanceof Error ? error.message : String(error)
    if (status === 404 || /\b404\b/.test(message)) {
      abapGit.status = 'not_installed'
      abapGit.detail = 'GET /sap/bc/adt/abapgit/repos returned 404 (abapGit ADT service absent)'
    } else if (status === 403) {
      abapGit.status = 'forbidden'
      abapGit.detail = 'GET /sap/bc/adt/abapgit/repos returned 403 (installed, but the current user lacks authorization)'
    } else if (/does not exist/i.test(message)) {
      // 该系统 ADT 对不存在的 ICF 资源回 "Resource ... does not exist."（无 404 码）
      abapGit.status = 'not_installed'
      abapGit.detail = 'ADT reports the abapgit repos resource does not exist (abapGit absent)'
    } else {
      abapGit.status = 'error'
      abapGit.detail = `git repos probe failed: ${message}`.slice(0, 200)
    }
  }

  return {
    localRuntime: { node: process.version },
    zadtVspHelper: helper,
    abapGit,
    notes
  }
}

/** 处理器注入用的窄客户端接口。 */
export interface InstallDiagnosticsClient {
  checkInstallPrerequisites(): Promise<InstallPrerequisitesResult>
}

/** 把 ADT 客户端绑定成处理器可注入的窄客户端。 */
export function createInstallDiagnosticsClient(client: InstallDiagnosticsCapability): InstallDiagnosticsClient {
  return {
    checkInstallPrerequisites: () => checkInstallPrerequisites(client)
  }
}
