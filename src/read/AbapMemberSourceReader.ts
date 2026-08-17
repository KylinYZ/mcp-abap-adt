import { createHash } from 'crypto';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { AbapObjectStructure, ObjectVersion, StructureElement } from '../adt/index.js';
import type { AbapObjectResolver } from '../safe/AbapObjectResolver.js';
import type { ResolvedAbapObject } from '../safe/types.js';

interface MemberSourceClient {
  objectStructureElements(objectUrl: string, version?: ObjectVersion): Promise<StructureElement[]>;
  objectStructure(objectUrl: string, version?: ObjectVersion): Promise<AbapObjectStructure>;
  getObjectSource(objectSourceUrl: string, options?: { version?: ObjectVersion }): Promise<string>;
}

export interface AbapMemberSourceInput {
  objectName: string;
  objectType: string;
  memberName: string;
  version?: ObjectVersion;
}

interface SourcePosition {
  line: number;
  column: number;
}

interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

interface RangedFragment {
  kind: 'definition' | 'implementation';
  range: SourceRange;
  source: string;
}

interface WholeSourceFragment {
  kind: 'include' | 'member';
  source: string;
}

export interface AbapMemberSourceResult {
  object: {
    objectType: ResolvedAbapObject['objectType'];
    objectName: string;
    adtType: string;
    packageName?: string;
  };
  member: {
    name: string;
    type: string;
  };
  version: ObjectVersion;
  fullSourceHash: string;
  fragments: Array<RangedFragment | WholeSourceFragment>;
}

interface ParsedBlockLink {
  kind: RangedFragment['kind'];
  sourceUrl: string;
  range: SourceRange;
}

export class AbapMemberSourceReader {
  constructor(
    private readonly client: MemberSourceClient,
    private readonly resolver: Pick<AbapObjectResolver, 'resolve'>
  ) {}

  async read(input: AbapMemberSourceInput): Promise<AbapMemberSourceResult> {
    const version = normalizeVersion(input?.version);
    const memberName = normalizeMemberName(input?.memberName);
    const object = await this.resolver.resolve(input?.objectType, input?.objectName);

    if (object.objectType === 'FUNCTION_MODULE') {
      if (memberName !== object.objectName) {
        throw invalid('For FUNCTION_MODULE, memberName must match objectName exactly.');
      }
      return this.readWholeSource(object, memberName, object.adtType, 'member', object.sourceUrl, version);
    }
    if (object.objectType !== 'CLASS') {
      throw invalid('getAbapMemberSource currently supports CLASS and FUNCTION_MODULE objects only.');
    }

    const elements = flatten(await this.client.objectStructureElements(object.objectUrl, version));
    const memberMatches = elements.filter(element => element.name.trim().toUpperCase() === memberName);
    if (memberMatches.length > 1) {
      throw invalid(`SAP ADT must return exactly one class member named ${memberName}.`);
    }
    if (memberMatches.length === 1) {
      return this.readRangedClassMember(object, memberMatches[0], version);
    }

    const structure = await this.client.objectStructure(object.objectUrl, version);
    const includes = 'includes' in structure ? structure.includes : [];
    const includeMatches = includes.filter(include => (
      String(include['adtcore:name'] || '').trim().toUpperCase() === memberName
      || String(include['class:includeType'] || '').trim().toUpperCase() === memberName
    ));
    if (includeMatches.length !== 1) {
      throw invalid(`SAP ADT did not resolve exactly one class member or include named ${memberName}.`);
    }
    const include = includeMatches[0];
    const sourceUrl = resolveSourceUrl(include['abapsource:sourceUri'], object.objectUrl);
    return this.readWholeSource(
      object,
      String(include['adtcore:name'] || memberName).toUpperCase(),
      String(include['adtcore:type'] || 'CLASS_INCLUDE'),
      'include',
      sourceUrl,
      version
    );
  }

  private async readRangedClassMember(
    object: ResolvedAbapObject,
    member: StructureElement,
    version: ObjectVersion
  ): Promise<AbapMemberSourceResult> {
    const blockLinks = member.links
      .map(link => parseBlockLink(link.rel, link.href, object.objectUrl))
      .filter((link): link is ParsedBlockLink => link !== undefined);
    if (blockLinks.length === 0) {
      throw invalid(`SAP ADT did not provide a source block range for class member ${member.name}.`);
    }
    const sourceUrls = new Set(blockLinks.map(link => link.sourceUrl));
    if (sourceUrls.size !== 1) {
      throw invalid(`SAP ADT returned inconsistent source ranges for class member ${member.name}.`);
    }
    const sourceUrl = [...sourceUrls][0];
    const fullSource = await this.client.getObjectSource(sourceUrl, { version });
    const fragments = blockLinks.map(link => ({
      kind: link.kind,
      range: link.range,
      source: cropInclusiveRange(fullSource, link.range)
    }));
    return result(object, member.name, member.type, version, fullSource, fragments);
  }

  private async readWholeSource(
    object: ResolvedAbapObject,
    memberName: string,
    memberType: string,
    kind: WholeSourceFragment['kind'],
    sourceUrl: string,
    version: ObjectVersion
  ): Promise<AbapMemberSourceResult> {
    const fullSource = await this.client.getObjectSource(sourceUrl, { version });
    return result(object, memberName, memberType, version, fullSource, [{ kind, source: fullSource }]);
  }
}

function result(
  object: ResolvedAbapObject,
  memberName: string,
  memberType: string,
  version: ObjectVersion,
  fullSource: string,
  fragments: Array<RangedFragment | WholeSourceFragment>
): AbapMemberSourceResult {
  return {
    object: {
      objectType: object.objectType,
      objectName: object.objectName,
      adtType: object.adtType,
      ...(object.packageName ? { packageName: object.packageName } : {})
    },
    member: { name: memberName, type: memberType },
    version,
    fullSourceHash: createHash('sha256').update(fullSource, 'utf8').digest('hex'),
    fragments
  };
}

function parseBlockLink(relValue: string, hrefValue: string, objectUrl: string): ParsedBlockLink | undefined {
  const relation = String(relValue || '').split('/').pop();
  if (relation !== 'definitionBlock' && relation !== 'implementationBlock') return undefined;
  const href = String(hrefValue || '').trim();
  const fragmentIndex = href.indexOf('#');
  if (fragmentIndex <= 0) throw invalid('SAP ADT returned a source block without a valid range.');
  const range = parseRange(href.slice(fragmentIndex));
  return {
    kind: relation === 'definitionBlock' ? 'definition' : 'implementation',
    sourceUrl: resolveSourceUrl(href.slice(0, fragmentIndex), objectUrl),
    range
  };
}

export function parseRange(value: string): SourceRange {
  const match = value.match(/^#start=(\d+),(\d+);end=(\d+),(\d+)$/);
  if (!match) throw invalid('SAP ADT returned a malformed source block range.');
  const range = {
    start: { line: Number(match[1]), column: Number(match[2]) },
    end: { line: Number(match[3]), column: Number(match[4]) }
  };
  if (range.start.line < 1 || range.end.line < range.start.line
    || (range.end.line === range.start.line && range.end.column < range.start.column)) {
    throw invalid('SAP ADT returned an invalid source block range.');
  }
  return range;
}

export function cropInclusiveRange(source: string, range: SourceRange): string {
  const lines = source.split(/\r\n|\n|\r/);
  const startLine = lines[range.start.line - 1];
  const endLine = lines[range.end.line - 1];
  if (startLine === undefined || endLine === undefined
    || range.start.column >= startLine.length || range.end.column >= endLine.length) {
    throw invalid('SAP ADT returned a source block range outside the full source.');
  }
  const selected = lines.slice(range.start.line - 1, range.end.line);
  if (selected.length === 1) {
    return selected[0].slice(range.start.column, range.end.column + 1);
  }
  selected[0] = selected[0].slice(range.start.column);
  selected[selected.length - 1] = selected[selected.length - 1].slice(0, range.end.column + 1);
  const eol = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n';
  return selected.join(eol);
}

function resolveSourceUrl(value: string, objectUrl: string): string {
  const normalized = String(value || '').trim();
  if (normalized.startsWith('/sap/bc/adt/')) return normalized;
  const relative = normalized.replace(/^\.\//, '');
  if (!relative || relative.startsWith('/') || relative.includes('..') || relative.includes('://') || /[?#]/.test(relative)) {
    throw invalid('SAP ADT returned an invalid member source URI.');
  }
  // ADT source links are relative to the object resource as a logical directory.
  return `${objectUrl.replace(/\/+$/, '')}/${relative}`;
}

function flatten(elements: StructureElement[]): StructureElement[] {
  const result: StructureElement[] = [];
  const visit = (items: StructureElement[]): void => {
    for (const item of items) {
      result.push(item);
      visit(item.children || []);
    }
  };
  visit(elements);
  return result;
}

function normalizeVersion(value: unknown): ObjectVersion {
  const normalized = String(value || 'active').trim();
  if (normalized === 'active' || normalized === 'inactive' || normalized === 'workingArea') return normalized;
  throw invalid('version must be active, inactive, or workingArea.');
}

function normalizeMemberName(value: unknown): string {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw invalid('memberName must be a non-empty string of at most 128 characters without control characters.');
  }
  return normalized;
}

function invalid(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message);
}
