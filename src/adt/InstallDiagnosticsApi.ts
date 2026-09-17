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
 *      依赖 helper，安装也属排除方向，此处仅报告现状；
 *   2. abapGit：GET /sap/bc/adt/abapgit/repos（abapGit 的 ADT 服务根）——200 可
 *      用；404 未安装；403 已装但当前用户无权限；其他为错误。
 *
 * 业务规则：
 *   - 全部只读（SELECT/GET）；任何探测失败都不中断整体报告（分类进对应
 *     状态或 error 字段）。
 *   - 本地运行时只报 Node 版本（本项目唯一的"本地依赖"）。
 */

/** ZADT_VSP helper 发现结果。 */
export interface HelperDiscovery {
  /** 是否发现 helper 对象（TADIR 有 ZADT_VSP% 记录）。 */
  installed: boolean
  /** 发现的 helper 对象（OBJ_NAME + OBJECT 类型）。 */
  objects: Array<{ name: string; type: string }>
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
}

/** 单元格容错字符串化。 */
function cell(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (value === undefined || value === null) return ''
  return String(value).trim()
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
  // 存在瞬时 500；仍失败按"未知"处理，不中断）
  const helper: HelperDiscovery = { installed: false, objects: [] }
  const tadirSql = "SELECT obj_name, object FROM tadir WHERE obj_name LIKE 'ZADT_VSP%'"
  try {
    let rows: Record<string, unknown>[] = []
    try {
      rows = (await client.runQuery(tadirSql, 50)).values ?? []
    } catch {
      rows = (await client.runQuery(tadirSql, 50)).values ?? []
    }
    for (const row of rows) {
      const name = cell(row, 'OBJ_NAME')
      const type = cell(row, 'OBJECT')
      if (name) helper.objects.push({ name, type })
    }
    helper.installed = helper.objects.length > 0
  } catch (error) {
    helper.detail = `TADIR probe failed: ${error instanceof Error ? error.message : String(error)}`
      .slice(0, 200)
  }

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
