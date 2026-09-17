import { SafeAbapError, errorMessage } from './errors.js';
import { normalizeObjectName } from './SafetyPolicy.js';
import type {
  ClassIncludeKind,
  ResolvedAbapObject,
  SafeAdtClient,
  SupportedObjectType
} from './types.js';
import { CLASS_INCLUDE_KINDS } from './types.js';

const SUPPORTED_TYPES = new Set<SupportedObjectType>(['PROGRAM', 'INCLUDE', 'CLASS', 'FUNCTION_MODULE']);

export class AbapObjectResolver {
  constructor(private readonly client: SafeAdtClient) {}

  async resolve(objectTypeValue: string, objectNameValue: string, classIncludeValue?: string): Promise<ResolvedAbapObject> {
    const objectType = normalizeObjectType(objectTypeValue);
    const objectName = normalizeObjectName(objectNameValue);
    const classInclude = normalizeClassInclude(classIncludeValue, objectType);

    try {
      const results = await this.client.searchObject(objectName, undefined, 50);
      const matches = results.filter(result => matchesObject(result, objectType, objectName));
      if (matches.length !== 1) {
        throw new SafeAbapError(
          'OBJECT_RESOLUTION_FAILED',
          'resolve',
          matches.length === 0
            ? `No exact ${objectType} object named ${objectName} was found.`
            : `Multiple exact ${objectType} objects named ${objectName} were found.`,
          { matchCount: matches.length }
        );
      }

      const searchResult = matches[0];
      const functionGroupInclude = objectType === 'INCLUDE' && isFunctionGroupInclude(searchResult);
      const structure = await this.client.objectStructure(searchResult['adtcore:uri'], 'active');
      const objectUrl = validateAdtUri(structure.objectUrl || searchResult['adtcore:uri'], 'object URL');
      // classInclude 提示下 sourceUrl 指向对应 include 的可写源资源；锁与激活仍归属父类
      const sourceUrl = classInclude
        ? resolveClassIncludeSourceUrl(structure, objectUrl, objectName, classInclude)
        : resolveSourceUrl(structure, objectUrl);
      let mainProgram: string | undefined;

      if (objectType === 'INCLUDE' && !functionGroupInclude) {
        // Program includes need a unique syntax/activation context; function-group includes are standalone FUGR/I resources.
        const mainPrograms = await this.client.mainPrograms(objectUrl);
        if (mainPrograms.length !== 1) {
          throw new SafeAbapError(
            'OBJECT_RESOLUTION_FAILED',
            'resolve',
            `Include ${objectName} must resolve to exactly one main program before it can be changed.`,
            {
              mainProgramCount: mainPrograms.length,
              candidates: mainPrograms.map(program => program['adtcore:name'])
            }
          );
        }
        mainProgram = validateAdtUri(mainPrograms[0]['adtcore:uri'], 'main program URL');
      }

      return {
        objectType,
        objectName,
        adtType: searchResult['adtcore:type'],
        objectUrl,
        sourceUrl,
        lockUrl: objectUrl,
        activationName: objectName,
        activationUrl: objectUrl,
        mainProgram,
        packageName: searchResult['adtcore:packageName'],
        parentObject: objectType === 'FUNCTION_MODULE' ? functionGroupName(objectUrl) : undefined,
        activationParentUrl: objectType === 'FUNCTION_MODULE' ? functionGroupUrl(objectUrl) : undefined,
        ...(classInclude ? { classInclude } : {})
      };
    } catch (error) {
      if (error instanceof SafeAbapError) {
        throw error;
      }
      throw new SafeAbapError(
        'OBJECT_RESOLUTION_FAILED',
        'resolve',
        `Failed to resolve ${objectType} ${objectName}: ${errorMessage(error)}`
      );
    }
  }
}

export function normalizeObjectType(value: string): SupportedObjectType {
  const normalized = String(value || '').trim().toUpperCase() as SupportedObjectType;
  if (!SUPPORTED_TYPES.has(normalized)) {
    throw new SafeAbapError(
      'OBJECT_RESOLUTION_FAILED',
      'resolve',
      'objectType must be PROGRAM, INCLUDE, CLASS, or FUNCTION_MODULE.'
    );
  }
  return normalized;
}

/**
 * 校验可选的 classInclude 提示：仅接受四种 include 粒度，且只对 CLASS 对象有意义。
 * 缺省返回 undefined（保持既有主源解析行为完全不变）。
 */
function normalizeClassInclude(value: string | undefined, objectType: SupportedObjectType): ClassIncludeKind | undefined {
  if (value === undefined || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  const kind = CLASS_INCLUDE_KINDS.find(candidate => candidate === normalized);
  if (!kind) {
    throw new SafeAbapError(
      'VALIDATION_FAILED',
      'resolve',
      `classInclude must be one of ${CLASS_INCLUDE_KINDS.join(', ')}.`
    );
  }
  if (objectType !== 'CLASS') {
    throw new SafeAbapError(
      'VALIDATION_FAILED',
      'resolve',
      `classInclude is only valid for CLASS objects (received objectType ${objectType}).`
    );
  }
  return kind;
}

/**
 * 从类 structure 的 includes 清单中解析指定 include 的可写源 URL。
 * testclasses include 在类没有测试类时不存在——此时给确定性错误并指引
 * 先用专家 createTestInclude 工具补建，而不是静默落到主源。
 */
function resolveClassIncludeSourceUrl(
  structure: Awaited<ReturnType<SafeAdtClient['objectStructure']>>,
  objectUrl: string,
  objectName: string,
  kind: ClassIncludeKind
): string {
  const includes = 'includes' in structure ? structure.includes : [];
  const match = includes.find(include => include['class:includeType'] === kind);
  if (!match) {
    throw new SafeAbapError(
      'OBJECT_RESOLUTION_FAILED',
      'resolve',
      kind === 'testclasses'
        ? `Class ${objectName} has no testclasses include; create it first (legacy createTestInclude tool) before editing it.`
        : `Class ${objectName} does not expose a ${kind} include source.`,
      { availableIncludeTypes: includes.map(include => String(include['class:includeType'] || '')) }
    );
  }
  return resolveAdtUri(match['abapsource:sourceUri'], objectUrl, `${kind} include source URL`);
}

function matchesObject(
  result: { 'adtcore:name': string; 'adtcore:type': string; 'adtcore:uri': string },
  objectType: SupportedObjectType,
  objectName: string
): boolean {
  const uri = safeDecode(result['adtcore:uri']).toUpperCase();
  const resultName = String(result['adtcore:name'] || '').toUpperCase();
  const exactName = resultName === objectName || uriObjectName(uri, objectType) === objectName;
  if (!exactName) {
    return false;
  }

  const adtType = String(result['adtcore:type'] || '').toUpperCase();
  switch (objectType) {
    case 'PROGRAM':
      return adtType.startsWith('PROG/P') || uri.includes('/PROGRAMS/PROGRAMS/');
    case 'INCLUDE':
      return adtType.startsWith('PROG/I') || uri.includes('/PROGRAMS/INCLUDES/') || isFunctionGroupInclude(result);
    case 'CLASS':
      return adtType.startsWith('CLAS/') || uri.includes('/OO/CLASSES/');
    case 'FUNCTION_MODULE':
      return uri.includes('/FUNCTIONS/GROUPS/') && uri.includes('/FMODULES/');
  }
}

function uriObjectName(uri: string, objectType: SupportedObjectType): string | undefined {
  const markers: Record<SupportedObjectType, string> = {
    PROGRAM: '/PROGRAMS/PROGRAMS/',
    INCLUDE: '/PROGRAMS/INCLUDES/',
    CLASS: '/OO/CLASSES/',
    FUNCTION_MODULE: '/FMODULES/'
  };
  const marker = objectType === 'INCLUDE'
    && uri.includes('/FUNCTIONS/GROUPS/')
    && uri.includes('/INCLUDES/')
    ? '/INCLUDES/'
    : markers[objectType];
  const markerIndex = uri.indexOf(marker);
  const relevant = markerIndex >= 0 ? uri.slice(markerIndex + marker.length) : '';
  const segments = relevant.split('/').filter(Boolean);
  return segments[0]?.toUpperCase();
}

function isFunctionGroupInclude(
  result: { 'adtcore:type': string; 'adtcore:uri': string }
): boolean {
  const adtType = String(result['adtcore:type'] || '').toUpperCase();
  const uri = safeDecode(result['adtcore:uri']).toUpperCase();
  return adtType.startsWith('FUGR/I')
    && uri.includes('/FUNCTIONS/GROUPS/')
    && uri.includes('/INCLUDES/');
}

function resolveSourceUrl(
  structure: Awaited<ReturnType<SafeAdtClient['objectStructure']>>,
  objectUrl: string
): string {
  const classIncludes = 'includes' in structure ? structure.includes : [];
  const mainClassInclude = classIncludes.find(include => include['class:includeType'] === 'main');
  const sourceUrl = mainClassInclude?.['abapsource:sourceUri'] || structure.metaData['abapsource:sourceUri'];
  if (!sourceUrl) {
    throw new SafeAbapError(
      'OBJECT_RESOLUTION_FAILED',
      'resolve',
      'SAP ADT metadata did not provide a writable source URI for this object.'
    );
  }
  return resolveAdtUri(sourceUrl, objectUrl, 'source URL');
}

function resolveAdtUri(value: string, objectUrl: string, label: string): string {
  const normalized = String(value || '').trim();
  if (normalized.startsWith('/sap/bc/adt/')) {
    return normalized;
  }
  if (!normalized || normalized.startsWith('/') || normalized.includes('://')) {
    throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'resolve', `Invalid ${label} returned by SAP ADT.`);
  }
  // SAP may return source links relative to the already validated object URL.
  return validateAdtUri(`${objectUrl.replace(/\/+$/, '')}/${normalized.replace(/^\/+/, '')}`, label);
}

function validateAdtUri(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized.startsWith('/sap/bc/adt/')) {
    throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'resolve', `Invalid ${label} returned by SAP ADT.`);
  }
  return normalized;
}

function functionGroupName(objectUrl: string): string | undefined {
  const decoded = safeDecode(objectUrl);
  const match = decoded.match(/\/functions\/groups\/([^/]+)\/fmodules\//i);
  return match?.[1]?.toUpperCase();
}

function functionGroupUrl(objectUrl: string): string | undefined {
  const match = objectUrl.match(/^(.*\/functions\/groups\/[^/]+)\/fmodules\/[^/]+$/i);
  return match?.[1];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
