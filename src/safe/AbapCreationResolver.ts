import type { SearchResult } from '../adt/index.js';
import { SafeAbapError, errorMessage } from './errors.js';
import { normalizeObjectName, SafetyPolicy } from './SafetyPolicy.js';
import { sourceHash } from './sourceTools.js';
import type {
  CreationAdtClient,
  CreationObjectInput,
  CreationObjectType,
  ResolvedCreationObject
} from './creationTypes.js';

const CREATION_TYPES = new Set<CreationObjectType>(['PROGRAM', 'FUNCTION_GROUP', 'FUNCTION_MODULE', 'FUNCTION_GROUP_INCLUDE']);

export class AbapCreationResolver {
  constructor(
    private readonly client: CreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async resolve(inputs: CreationObjectInput[]): Promise<ResolvedCreationObject[]> {
    const objects = normalizeGraph(inputs, this.policy);
    await this.assertTargetsAbsent(objects);

    const newFunctionGroup = objects.find(object => object.objectType === 'FUNCTION_GROUP');
    for (const object of objects) {
      if (object.objectType === 'FUNCTION_MODULE'
        && newFunctionGroup
        && object.parentFunctionGroup === newFunctionGroup.objectName) {
        object.packageName = newFunctionGroup.packageName;
      } else if (object.objectType === 'FUNCTION_MODULE' || object.objectType === 'FUNCTION_GROUP_INCLUDE') {
        const parent = await this.requireExactObject('FUNCTION_GROUP', object.parentFunctionGroup as string);
        object.packageName = String(parent['adtcore:packageName'] || '').trim().toUpperCase();
        // 记录搜索返回的父组 URI：软检查优先用它，避免依赖自拼 URL 形态（7.51 兼容）。
        object.parentUri = safeParentUri(parent['adtcore:uri']);
        this.policy.assertTransportablePackage(object.packageName);
      } else {
        const packageObject = await this.requireExactObject('PACKAGE', object.packageName);
        // 记录搜索返回的包 URI（7.51 兼容：软检查不再只用自拼 parentPath）。
        object.parentUri = safeParentUri(packageObject['adtcore:uri']);
      }
    }
    return objects;
  }

  async assertTargetsAbsent(objects: ResolvedCreationObject[]): Promise<void> {
    for (const object of objects) {
      const matches = await this.exactMatches(object.objectType, object.objectName);
      if (matches.length > 0) {
        throw new SafeAbapError(
          'OBJECT_ALREADY_EXISTS',
          'resolve',
          `${object.objectType} ${object.objectName} already exists; safe creation never overwrites existing objects.`,
          { matchCount: matches.length }
        );
      }
    }
  }

  async resolveCreated(
    expected: ResolvedCreationObject,
    version: 'active' | 'inactive' | 'workingArea' = 'inactive'
  ): Promise<ResolvedCreationObject> {
    const match = await this.requireExactObject(expected.objectType, expected.objectName);
    try {
      const structure = await this.client.objectStructure(match['adtcore:uri'], version);
      const objectUrl = validateAdtUri(structure.objectUrl || match['adtcore:uri']);
      const actualPackage = String(match['adtcore:packageName'] || expected.packageName).trim().toUpperCase();
      if (expected.packageName && actualPackage !== expected.packageName) {
        throw new SafeAbapError(
          'OBJECT_CREATION_FAILED',
          'resolve-created',
          `New object ${expected.objectName} was created in unexpected package ${actualPackage || '[unknown]'}.`
        );
      }
      const sourceUri = structure.metaData['abapsource:sourceUri'];
      const sourceUrl = sourceUri ? resolveAdtUri(sourceUri, objectUrl) : undefined;
      if (!sourceUrl) {
        throw new SafeAbapError(
          'OBJECT_CREATION_FAILED',
          'resolve-created',
          `SAP ADT did not return a source resource for ${expected.objectName}.`
        );
      }
      return { ...expected, packageName: actualPackage, objectUrl, sourceUrl };
    } catch (error) {
      if (error instanceof SafeAbapError) throw error;
      throw new SafeAbapError(
        'OBJECT_CREATION_FAILED',
        'resolve-created',
        `Failed to resolve newly created ${expected.objectName}: ${errorMessage(error)}`
      );
    }
  }

  private async requireExactObject(
    objectType: CreationObjectType | 'PACKAGE',
    objectName: string
  ): Promise<SearchResult> {
    const matches = await this.exactMatches(objectType, objectName);
    if (matches.length !== 1) {
      throw new SafeAbapError(
        'PARENT_NOT_FOUND',
        'resolve-parent',
        matches.length === 0
          ? `${objectType} ${objectName} was not found.`
          : `${objectType} ${objectName} resolved to multiple exact objects.`,
        { matchCount: matches.length }
      );
    }
    return matches[0];
  }

  private async exactMatches(
    objectType: CreationObjectType | 'PACKAGE',
    objectName: string
  ): Promise<SearchResult[]> {
    try {
      const results = await this.client.searchObject(objectName, undefined, 50);
      return results.filter(result => matchesObject(result, objectType, objectName));
    } catch (error) {
      if (error instanceof SafeAbapError) throw error;
      // A7 降级：ADT quick search 通道不可用时（真机实证：该 DEV quicksearch 端点
      // 会间歇性 400 且不自愈），改用 TADIR 只读 SQL 判定对象是否存在——TADIR 是
      // 仓库对象登记的权威表，对"缺席判定"与 quick search 等价（有行=已登记）。
      // FUNCTION_GROUP_INCLUDE 是组内 include 无独立 R3TR 登记键，不适用降级。
      const tadirObject = TADIR_OBJECT_BY_TYPE[objectType];
      if (!tadirObject || typeof this.client.runQuery !== 'function') {
        throw new SafeAbapError(
          'OBJECT_RESOLUTION_FAILED',
          'resolve',
          `Failed to search for ${objectType} ${objectName}: ${errorMessage(error)}`
        );
      }
      return this.exactMatchesByTadir(tadirObject, objectType, objectName, error);
    }
  }

  /**
   * quick search 不可用时的只读 SQL 降级：命中即视为对象已存在。
   * 真机实证：datapreview 的 WHERE 对多条件 AND 组合报 400——全部用单条件查询，
   * 精确匹配在客户端完成（objectName 已被 normalizeObjectName 白名单校验，无注入面）。
   * PROGRAM 直接查 REPOSRC（源码级存在）——TADIR 孤儿条目（删除后登记残留）不算存在，
   * 避免把可重建的对象误判为已存在；其余类型 TADIR 单条件 + 客户端过滤
   * （孤儿会保守误判为存在=拒绝创建，是安全侧错误，GUI 清孤儿后可重试）。
   */
  private async exactMatchesByTadir(
    tadirObject: string,
    objectType: CreationObjectType | 'PACKAGE',
    objectName: string,
    cause: unknown
  ): Promise<SearchResult[]> {
    try {
      if (objectType === 'PROGRAM') {
        const rows = (await this.client.runQuery!(
          `SELECT progname FROM reposrc WHERE progname = '${objectName}'`,
          10
        )).values ?? [];
        return rows
          .filter(row => String(row.PROGNAME || '').toUpperCase() === objectName.toUpperCase())
          .map(row => ({
            'adtcore:name': String(row.PROGNAME || '').toUpperCase(),
            'adtcore:type': TADIR_ADT_TYPE[tadirObject] || tadirObject,
            'adtcore:uri': ''
          }));
      }
      const result = await this.client.runQuery!(
        `SELECT obj_name, object, pgmid FROM tadir WHERE obj_name = '${objectName}'`,
        10
      );
      const rows = result?.values ?? [];
      return rows
        .filter(row => String(row.PGMID || '').toUpperCase() === 'R3TR'
          && String(row.OBJECT || '').toUpperCase() === tadirObject
          && String(row.OBJ_NAME || '').toUpperCase() === objectName.toUpperCase())
        .map(row => ({
          // 构造 matchesObject 兼容的 quick search 条目形态（adtcore:type 用链路同款前缀）
          'adtcore:name': String(row.OBJ_NAME || '').toUpperCase(),
          'adtcore:type': TADIR_ADT_TYPE[tadirObject] || tadirObject,
          'adtcore:uri': ''
        }));
    } catch (queryError) {
      // 两条通道都失败：如实失败（不得把未知当缺席——创建会覆盖已存在对象）
      throw new SafeAbapError(
        'OBJECT_RESOLUTION_FAILED',
        'resolve',
        `Quick search failed (${errorMessage(cause)}) and the TADIR fallback also failed `
        + `(${errorMessage(queryError)}); existence of ${objectType} ${objectName} cannot be determined.`
      );
    }
  }
}

/** 创建类型 → TADIR R3TR OBJECT 键。 */
const TADIR_OBJECT_BY_TYPE: Record<string, string> = {
  PROGRAM: 'PROG',
  FUNCTION_GROUP: 'FUGR',
  FUNCTION_MODULE: 'FUNC',
  PACKAGE: 'DEVC'
}

/** TADIR OBJECT → matchesObject 可识别的 adtcore:type 前缀。 */
const TADIR_ADT_TYPE: Record<string, string> = {
  PROG: 'PROG/P',
  FUGR: 'FUGR/F',
  FUNC: 'FUGR/FF',
  DEVC: 'DEVC/K'
}

function normalizeGraph(inputs: CreationObjectInput[], policy: SafetyPolicy): ResolvedCreationObject[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 2) {
    throw invalidGraph('objects must contain one supported object or one function group followed by one function module.');
  }

  const normalized = inputs.map(input => normalizeInput(input, policy));
  const graph = normalized.map(object => object.objectType).join(',');
  if (!['PROGRAM', 'FUNCTION_GROUP', 'FUNCTION_MODULE', 'FUNCTION_GROUP_INCLUDE', 'FUNCTION_GROUP,FUNCTION_MODULE'].includes(graph)) {
    throw invalidGraph('Unsupported object creation graph.');
  }
  if (graph === 'FUNCTION_GROUP') {
    throw invalidGraph(
      'Standalone FUNCTION_GROUP creation is disabled until its Eclipse ADT activation protocol is captured.'
    );
  }
  if (graph === 'FUNCTION_GROUP,FUNCTION_MODULE'
    && normalized[1].parentFunctionGroup !== normalized[0].objectName) {
    throw invalidGraph('The function module must name the new function group as its parent.');
  }
  if (new Set(normalized.map(object => `${object.objectType}:${object.objectName}`)).size !== normalized.length) {
    throw invalidGraph('Duplicate objects are not allowed in one creation plan.');
  }
  return normalized;
}

function normalizeInput(input: CreationObjectInput, policy: SafetyPolicy): ResolvedCreationObject {
  const objectType = normalizeCreationType(input?.objectType);
  const objectName = normalizeObjectName(input?.objectName);
  if (objectType !== 'FUNCTION_GROUP_INCLUDE') policy.assertMutationAllowed(objectName);
  const description = String(input?.description || '').trim();
  if (!description) throw invalidGraph(`description is required for ${objectName}.`);

  if (objectType === 'FUNCTION_MODULE' || objectType === 'FUNCTION_GROUP_INCLUDE') {
    const parentFunctionGroup = normalizeObjectName(input.parentFunctionGroup || '');
    policy.assertMutationAllowed(parentFunctionGroup);
    if (input.packageName) throw invalidGraph('FUNCTION_MODULE must not provide packageName.');
    const source = requireSource(input.source, objectType, objectName);
    if (objectType === 'FUNCTION_MODULE') assertSourceFrame(objectType, objectName, source);
    const parentPath = functionGroupUrl(parentFunctionGroup);
    const creationName = objectType === 'FUNCTION_GROUP_INCLUDE' ? validateIncludeSuffix(objectName) : undefined;
    const fullName = objectType === 'FUNCTION_GROUP_INCLUDE'
      ? deriveFunctionGroupIncludeName(parentFunctionGroup, creationName as string)
      : objectName;
    // Generated include names begin with SAP's `L` prefix (for example LZFGTOP),
    // so the parent function-group namespace is the authoritative policy boundary.
    const objectUrl = objectType === 'FUNCTION_GROUP_INCLUDE'
      ? `${parentPath}/includes/${encodeSegment(fullName)}`
      : `${parentPath}/fmodules/${encodeSegment(objectName)}`;
    return {
      objectType,
      objectName: fullName,
      description,
      adtType: objectType === 'FUNCTION_GROUP_INCLUDE' ? 'FUGR/I' : 'FUGR/FF',
      packageName: '',
      parentName: parentFunctionGroup,
      parentPath,
      parentFunctionGroup,
      objectUrl,
      creationName,
      sourceUrl: `${objectUrl}/source/main`,
      activationParentUrl: parentPath,
      source,
      sourceHash: sourceHash(source)
    };
  }

  const packageName = policy.assertTransportablePackage(input.packageName);
  if (input.parentFunctionGroup) throw invalidGraph(`${objectType} must not provide parentFunctionGroup.`);
  if (objectType === 'FUNCTION_GROUP') {
    if (input.source !== undefined) throw invalidGraph('FUNCTION_GROUP source is managed by SAP and is forbidden in phase one.');
    return {
      objectType,
      objectName,
      description,
      adtType: 'FUGR/F',
      packageName,
      parentName: packageName,
      parentPath: packageUrl(packageName),
      objectUrl: functionGroupUrl(objectName),
      sourceUrl: `${functionGroupUrl(objectName)}/source/main`
    };
  }

  const source = requireSource(input.source, objectType, objectName);
  assertSourceFrame(objectType, objectName, source);
  const objectUrl = `/sap/bc/adt/programs/programs/${encodeSegment(objectName)}`;
  return {
    objectType,
    objectName,
    description,
    adtType: 'PROG/P',
    packageName,
    parentName: packageName,
    parentPath: packageUrl(packageName),
    objectUrl,
    sourceUrl: `${objectUrl}/source/main`,
    source,
    sourceHash: sourceHash(source)
  };
}

function normalizeCreationType(value: string): CreationObjectType {
  const normalized = String(value || '').trim().toUpperCase() as CreationObjectType;
  if (!CREATION_TYPES.has(normalized)) {
    throw invalidGraph('objectType must be PROGRAM, FUNCTION_GROUP, FUNCTION_MODULE, or FUNCTION_GROUP_INCLUDE.');
  }
  return normalized;
}

function requireSource(value: string | undefined, objectType: CreationObjectType, objectName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidGraph(`Complete source is required for ${objectType} ${objectName}.`);
  }
  return value;
}

function assertSourceFrame(objectType: CreationObjectType, objectName: string, source: string): void {
  const escaped = escapeRegExp(objectName);
  if (objectType === 'PROGRAM' && !new RegExp(`^\\s*(REPORT|PROGRAM)\\s+${escaped}\\s*\\.`, 'i').test(source)) {
    throw invalidGraph(`Program source must start with REPORT or PROGRAM ${objectName}.`);
  }
  if (objectType === 'FUNCTION_MODULE') {
    if (!new RegExp(`^\\s*FUNCTION\\s+${escaped}(?:\\s|\\.)`, 'i').test(source)
      || !/ENDFUNCTION\s*\.\s*$/i.test(source)) {
      throw invalidGraph(`Function-module source must start with FUNCTION ${objectName} and end with ENDFUNCTION.`);
    }
  }
}

function matchesObject(
  result: SearchResult,
  objectType: CreationObjectType | 'PACKAGE',
  objectName: string
): boolean {
  const name = String(result['adtcore:name'] || '').toUpperCase();
  const type = String(result['adtcore:type'] || '').toUpperCase();
  const uri = safeDecode(String(result['adtcore:uri'] || '')).toUpperCase();
  if (name !== objectName.toUpperCase()) return false;
  switch (objectType) {
    case 'PROGRAM': return type.startsWith('PROG/P') || uri.includes('/PROGRAMS/PROGRAMS/');
    case 'FUNCTION_GROUP': return type === 'FUGR/F' || /\/FUNCTIONS\/GROUPS\/[^/]+$/.test(uri);
    case 'FUNCTION_MODULE': return type.startsWith('FUGR/FF') || uri.includes('/FMODULES/');
    case 'FUNCTION_GROUP_INCLUDE': return type === 'FUGR/I' || uri.includes('/FUNCTIONS/GROUPS/') && uri.includes('/INCLUDES/');
    case 'PACKAGE': return type === 'DEVC/K' || uri.includes('/PACKAGES/');
  }
}

function validateIncludeSuffix(value: string): string {
  if (!/^(?=.*[A-Z0-9])[A-Z0-9_]{3}$/.test(value)) {
    throw invalidGraph('FUNCTION_GROUP_INCLUDE name must be a three-character include suffix.');
  }
  return value;
}

function deriveFunctionGroupIncludeName(functionGroup: string, suffix: string): string {
  const parts = functionGroup.split('/');
  return parts.length < 3 ? `L${functionGroup}${suffix}` : `/${parts[1]}/L${parts[2]}${suffix}`;
}

function packageUrl(packageName: string): string {
  return `/sap/bc/adt/packages/${encodeSegment(packageName)}`;
}

/**
 * 校验搜索返回的父对象 URI：只接受相对 ADT 路径形态；绝对 URL、越界段、
 * 查询串一律弃用（返回 undefined，调用方回退自拼 parentPath）。软检查的
 * URI 来源从"自拼"升级为"SAP 搜索返回"，但形态仍要过这道防线。
 */
function safeParentUri(value: unknown): string | undefined {
  const uri = String(value ?? '').trim();
  if (!/^\/sap\/bc\/adt\//.test(uri)
    || uri.includes('://')
    || /(^|\/)\.\.(\/|$)/.test(uri)
    || /[?#]/.test(uri)) {
    return undefined;
  }
  return uri;
}

function functionGroupUrl(functionGroup: string): string {
  return `/sap/bc/adt/functions/groups/${encodeSegment(functionGroup)}`;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value.toLowerCase());
}

function resolveAdtUri(value: string, objectUrl: string): string {
  const normalized = String(value || '').trim();
  if (normalized.startsWith('/sap/bc/adt/')) return normalized;
  if (!normalized || normalized.startsWith('/') || normalized.includes('://')) {
    throw new SafeAbapError('OBJECT_CREATION_FAILED', 'resolve-created', 'SAP ADT returned an invalid source URI.');
  }
  return validateAdtUri(`${objectUrl.replace(/\/+$/, '')}/${normalized.replace(/^\/+/, '')}`);
}

function validateAdtUri(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized.startsWith('/sap/bc/adt/')) {
    throw new SafeAbapError('OBJECT_CREATION_FAILED', 'resolve-created', 'SAP ADT returned an invalid object URI.');
  }
  return normalized;
}

function invalidGraph(message: string): SafeAbapError {
  return new SafeAbapError('INVALID_CREATION_GRAPH', 'validate', message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
