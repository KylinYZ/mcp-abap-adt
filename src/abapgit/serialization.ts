/**
 * ============================================================================
 * abapGit 离线序列化解析器（文件名 → 逻辑对象分组）
 * ============================================================================
 *
 * 用途：把 abapGit 离线包内的文件清单解析为"逻辑对象"清单——同一对象的
 * 主源/局部包含/测试类/XML 元数据归为一组，供部署计划层排序与执行。
 *
 * 文件命名口径（abapGit 序列化约定，真机离线包实测 2026-09-18）：
 *   - `<名>.<类型>.<扩展>`：主文件（clas/intf/prog/fugr/devc/tran/w3mi；
 *     扩展 abap=源码、xml=元数据）
 *   - `<名>.clas.testclasses.abap` / `<名>.clas.locals_def.abap` /
 *     `<名>.clas.locals_imp.abap`：类局部/测试包含
 *   - `<名>.fugr.<包含名>.abap`：函数组包含（另有个别 `L<名>TOP`/`SAPL<名>`
 *     形态的无类型标记文件——归入"未识别"，不计入部署对象）
 *   - `package.devc.xml`：包定义；`.abapgit.xml`：仓库清单（非对象）
 *   - css/woff/js 等散件：W3MI 的 MIME 数据载荷（随 W3MI 一起跳过）
 *
 * 边界：本层不做任何 SAP 往返，纯本地解析；未知类型/形态不猜测，归入
 * unrecognized 并保留原因（部署层跳过并记 notes）。
 */

import type { ZipTextEntry } from './zip-reader.js'

/** 支持部署的 R3TR 对象类型（本离线包实测覆盖面）。 */
export type DeployableObjectType = 'CLAS' | 'INTF' | 'PROG' | 'FUGR' | 'DEVC'

/** 部署范围外的对象类型（跳过并记原因）。 */
export type SkippedObjectType = 'W3MI' | 'TRAN'

/** 解析出的一个逻辑对象。 */
export interface AbapGitObject {
  /** 对象名（大写，SAP 对象口径）。 */
  readonly name: string
  /** R3TR 对象类型。 */
  readonly type: DeployableObjectType
  /** ZIP 内相对文件夹（包层级映射的依据，空串=根）。 */
  readonly folder: string
  /** 主源码（.abap；DEVC 无）。 */
  readonly mainSource?: string
  /** 类测试类包含（仅 CLAS）。 */
  readonly testclassesSource?: string
  /** 类局部定义/实现包含（仅 CLAS）。 */
  readonly localsDefSource?: string
  readonly localsImpSource?: string
  /** 元数据 XML 原文（如 .clas.xml；描述从中提取）。 */
  readonly metadataXml?: string
  /** 描述（XML TPOOL 首条或对象名回退）。 */
  readonly description: string
}

/** 无法归组的文件（跳过并记原因）。 */
export interface UnrecognizedFile {
  readonly path: string
  readonly reason: string
}

/** 离线包解析结果。 */
export interface AbapGitParseResult {
  /** 仓库清单 .abapgit.xml 原文（存在时）。 */
  readonly manifestXml?: string
  /** 可部署对象（按 类型→名字 排序）。 */
  readonly objects: readonly AbapGitObject[]
  /** 部署范围外但已识别的对象（W3MI/TRAN）。 */
  readonly skippedObjects: ReadonlyArray<{ name: string, type: SkippedObjectType, folder: string }>
  /** 无法归组的散件（MIME 载荷/未识别形态）。 */
  readonly unrecognized: readonly UnrecognizedFile[]
}

/** 对象类型标记 → R3TR 类型（只列本包支持/已识别面）。 */
const TYPE_BY_MARKER: Record<string, 'CLAS' | 'INTF' | 'PROG' | 'FUGR' | 'DEVC' | 'W3MI' | 'TRAN'> = {
  clas: 'CLAS',
  intf: 'INTF',
  prog: 'PROG',
  fugr: 'FUGR',
  devc: 'DEVC',
  w3mi: 'W3MI',
  tran: 'TRAN'
}

/** 类型语义序（越小越先，与部署计划层一致：包 → 接口 → 类 → 程序 → 函数组）。 */
const TYPE_SORT_ORDER: Record<string, number> = { DEVC: 0, INTF: 1, CLAS: 2, PROG: 3, FUGR: 4, W3MI: 8, TRAN: 9 }

/** 类包含文件段名（.<名>.clas.<段>.abap 的段）。 */
const CLASS_INCLUDE_SEGMENTS = new Set(['testclasses', 'locals_def', 'locals_imp'])

/** 从类/接口元数据 XML 提取描述（TPOOL 的 S/00 条目；失败回退对象名）。 */
function extractDescription(metadataXml: string | undefined, fallback: string): string {
  if (metadataXml === undefined) return fallback
  const entry = metadataXml.match(/<ID>S<\/ID>\s*<KEY>0*<\/KEY>\s*<ENTRY>([^<]*)<\/ENTRY>/)
    ?? metadataXml.match(/<ENTRY>([^<]{4,})<\/ENTRY>/)
  const text = entry?.[1]?.trim()
  return text !== undefined && text !== '' ? text : fallback
}

/**
 * 单文件解析：路径 → {文件夹, 对象名, 类型, 段, 扩展}；不符合约定返回 undefined。
 *
 * 段位口径（abapGit 序列化约定）：
 *   `<名>.<类型>.<扩展>`（3 段：主文件）；
 *   `<名>.<类型>.<段>.<扩展>`（4 段：类包含，如 zcl_x.clas.testclasses.abap）。
 * 类型标记取扩展名前一位；四段形态的段取再前一位，名字取其余前缀。
 */
function parseFilePath(
  path: string
): { folder: string, name: string, type: 'CLAS' | 'INTF' | 'PROG' | 'FUGR' | 'DEVC' | 'W3MI' | 'TRAN', segment?: string, extension: string } | undefined {
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  const fileName = slash === -1 ? path : path.slice(slash + 1)
  const segments = fileName.split('.')
  if (segments.length < 3) return undefined
  const extension = segments[segments.length - 1]
  if (extension !== 'abap' && extension !== 'xml') return undefined
  // `.abapgit.xml`（仓库清单）为特殊名，非对象
  if (segments[segments.length - 2].toLowerCase() === 'abapgit') return undefined

  const typeMarker = segments[segments.length - 2].toLowerCase()
  // 四段类包含优先判定：.<名>.<类型>.<段>.<扩展>——段在扩展前一位、类型在再前一位
  if (segments.length >= 4) {
    const segment = segments[segments.length - 2].toLowerCase()
    const type2 = TYPE_BY_MARKER[segments[segments.length - 3].toLowerCase()]
    if (CLASS_INCLUDE_SEGMENTS.has(segment) && type2 !== undefined && extension === 'abap') {
      const name = segments.slice(0, segments.length - 3).join('_').toUpperCase()
      return { folder, name, type: type2, segment, extension }
    }
  }
  const type = TYPE_BY_MARKER[typeMarker]
  if (type !== undefined) {
    const name = segments.slice(0, segments.length - 2).join('_').toUpperCase()
    return { folder, name, type, extension }
  }
  return undefined
}

/**
 * 解析离线包条目清单为逻辑对象分组。
 * 输入顺序保持 ZIP 目录序；输出对象按 类型→名字 排序（部署计划的稳定输入）。
 */
export function parseAbapGitOfflineEntries(entries: readonly ZipTextEntry[]): AbapGitParseResult {
  const manifestPaths = entries.filter(entry => entry.path.endsWith('/.abapgit.xml') || entry.path === '.abapgit.xml')
  const manifestXml = manifestPaths[0]?.text
  // key: type|folder|name → 累积文件
  const grouped = new Map<string, {
    type: DeployableObjectType | SkippedObjectType
    folder: string
    name: string
    mainSource?: string
    testclassesSource?: string
    localsDefSource?: string
    localsImpSource?: string
    metadataXml?: string
  }>()
  const unrecognized: UnrecognizedFile[] = []
  let devcXmlCount = 0

  for (const entry of entries) {
    const parsed = parseFilePath(entry.path)
    if (parsed === undefined) {
      // 非对象文件：清单/散件（css 等）均归入 unrecognized，清单在上面单独取
      if (!entry.path.endsWith('/.abapgit.xml') && entry.path !== '.abapgit.xml') {
        unrecognized.push({ path: entry.path, reason: 'not an abapGit object file' })
      }
      continue
    }
    const key = `${parsed.type}|${parsed.folder}|${parsed.name}`
    const existing = grouped.get(key)
    const bucket = existing ?? {
      type: parsed.type,
      folder: parsed.folder,
      name: parsed.name
    }
    if (existing === undefined) grouped.set(key, bucket)
    if (parsed.extension === 'xml') {
      bucket.metadataXml = entry.text
      if (parsed.type === 'DEVC') devcXmlCount += 1
      continue
    }
    // 源码按段归位
    if (parsed.segment === 'testclasses') bucket.testclassesSource = entry.text
    else if (parsed.segment === 'locals_def') bucket.localsDefSource = entry.text
    else if (parsed.segment === 'locals_imp') bucket.localsImpSource = entry.text
    else bucket.mainSource = entry.text
  }

  const objects: AbapGitObject[] = []
  const skippedObjects: Array<{ name: string, type: SkippedObjectType, folder: string }> = []
  for (const bucket of grouped.values()) {
    if (bucket.type === 'W3MI' || bucket.type === 'TRAN') {
      skippedObjects.push({ name: bucket.name, type: bucket.type, folder: bucket.folder })
      continue
    }
    if (bucket.type === 'DEVC' && bucket.mainSource === undefined && devcXmlCount > 0) {
      // DEVC 只有 XML 定义（合法形态）
    }
    objects.push({
      name: bucket.name,
      type: bucket.type,
      folder: bucket.folder,
      ...(bucket.mainSource !== undefined ? { mainSource: bucket.mainSource } : {}),
      ...(bucket.testclassesSource !== undefined ? { testclassesSource: bucket.testclassesSource } : {}),
      ...(bucket.localsDefSource !== undefined ? { localsDefSource: bucket.localsDefSource } : {}),
      ...(bucket.localsImpSource !== undefined ? { localsImpSource: bucket.localsImpSource } : {}),
      ...(bucket.metadataXml !== undefined ? { metadataXml: bucket.metadataXml } : {}),
      description: extractDescription(bucket.metadataXml, bucket.name)
    })
  }
  objects.sort((left, right) =>
    (TYPE_SORT_ORDER[left.type] - TYPE_SORT_ORDER[right.type])
    || left.name.localeCompare(right.name))
  skippedObjects.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name))
  return {
    ...(manifestXml !== undefined ? { manifestXml } : {}),
    objects,
    skippedObjects,
    unrecognized
  }
}
