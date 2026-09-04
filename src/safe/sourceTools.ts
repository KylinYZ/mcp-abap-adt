import { createHash } from 'crypto';
import type { DiffSummary, SourceMatchType } from './types.js';

export interface SourceComparison {
  matches: boolean;
  matchType: SourceMatchType;
  expectedHash: string;
  actualHash: string;
}

export interface SafeSourceMismatchSummary {
  expectedHash: string;
  actualHash: string;
  expectedLineCount: number;
  actualLineCount: number;
  firstMismatchLine: number;
  expectedLineBytes: number;
  actualLineBytes: number;
  expectedLineHash: string;
  actualLineHash: string;
}

export function sourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function compareSources(expectedSource: string, actualSource: string): SourceComparison {
  const expectedHash = sourceHash(expectedSource);
  const actualHash = sourceHash(actualSource);
  if (expectedHash === actualHash) {
    return { matches: true, matchType: 'EXACT', expectedHash, actualHash };
  }
  if (normalizeLineEndings(expectedSource) === normalizeLineEndings(actualSource)) {
    return { matches: true, matchType: 'LINE_ENDING_NORMALIZED', expectedHash, actualHash };
  }
  return { matches: false, matchType: 'DIFFERENT', expectedHash, actualHash };
}

export function compareFunctionModuleSources(
  expectedSource: string,
  actualSource: string
): SourceComparison {
  const strictComparison = compareSources(expectedSource, actualSource);
  if (strictComparison.matches) return strictComparison;

  const normalizedExpected = normalizeFunctionModuleFormatting(expectedSource);
  const normalizedActual = normalizeFunctionModuleFormatting(actualSource);
  if (normalizedExpected !== undefined
    && normalizedActual !== undefined
    && normalizedExpected === normalizedActual) {
    return {
      ...strictComparison,
      matches: true,
      matchType: 'FUNCTION_MODULE_FORMAT_NORMALIZED'
    };
  }
  return strictComparison;
}

export function compareAbapClassSources(
  expectedSource: string,
  actualSource: string
): SourceComparison {
  const strictComparison = compareSources(expectedSource, actualSource);
  if (strictComparison.matches) return strictComparison;

  const normalizedExpected = normalizeEmptyAbapClassFormatting(expectedSource);
  const normalizedActual = normalizeEmptyAbapClassFormatting(actualSource);
  if (normalizedExpected !== undefined
    && normalizedActual !== undefined
    && normalizedExpected === normalizedActual) {
    return {
      ...strictComparison,
      matches: true,
      matchType: 'ABAP_CLASS_FORMAT_NORMALIZED'
    };
  }
  return strictComparison;
}

export function compareDdicStructureSources(
  expectedSource: string,
  actualSource: string
): SourceComparison {
  const strictComparison = compareSources(expectedSource, actualSource);
  if (strictComparison.matches) return strictComparison;

  const normalizedExpected = normalizeDdicStructureClosingBlank(expectedSource);
  const normalizedActual = normalizeDdicStructureClosingBlank(actualSource);
  if (normalizedExpected !== undefined
    && normalizedActual !== undefined
    && normalizedExpected === normalizedActual) {
    return {
      ...strictComparison,
      matches: true,
      matchType: 'DDIC_STRUCTURE_FORMAT_NORMALIZED'
    };
  }
  return strictComparison;
}

export function safeSourceMismatchSummary(
  expectedSource: string,
  actualSource: string
): SafeSourceMismatchSummary {
  const expectedLines = normalizeLineEndings(expectedSource).split('\n');
  const actualLines = normalizeLineEndings(actualSource).split('\n');
  const maximum = Math.max(expectedLines.length, actualLines.length);
  let index = 0;
  while (index < maximum && expectedLines[index] === actualLines[index]) index += 1;
  const expectedLine = expectedLines[index] ?? '';
  const actualLine = actualLines[index] ?? '';
  return {
    expectedHash: sourceHash(expectedSource),
    actualHash: sourceHash(actualSource),
    expectedLineCount: expectedLines.length,
    actualLineCount: actualLines.length,
    firstMismatchLine: index + 1,
    expectedLineBytes: Buffer.byteLength(expectedLine, 'utf8'),
    actualLineBytes: Buffer.byteLength(actualLine, 'utf8'),
    expectedLineHash: sourceHash(expectedLine),
    actualLineHash: sourceHash(actualLine)
  };
}

export function createUnifiedDiff(originalSource: string, targetSource: string): { diff: string; summary: DiffSummary } {
  const originalLines = splitLines(originalSource);
  const targetLines = splitLines(targetSource);
  let prefix = 0;
  while (
    prefix < originalLines.length
    && prefix < targetLines.length
    && originalLines[prefix] === targetLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix
    && suffix < targetLines.length - prefix
    && originalLines[originalLines.length - 1 - suffix] === targetLines[targetLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = originalLines.slice(prefix, originalLines.length - suffix);
  const added = targetLines.slice(prefix, targetLines.length - suffix);
  const header = `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`;
  const body = [
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`)
  ];

  return {
    diff: ['--- current', '+++ proposed', header, ...body].join('\n'),
    summary: {
      addedLines: added.length,
      removedLines: removed.length,
      unchangedPrefixLines: prefix,
      unchangedSuffixLines: suffix
    }
  };
}

function splitLines(source: string): string[] {
  return source.replace(/\r\n/g, '\n').split('\n');
}

function normalizeLineEndings(source: string): string {
  // SAP may normalize line separators and the final line terminator during activation.
  return source.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

function normalizeEmptyAbapClassFormatting(source: string): string | undefined {
  const text = normalizeLineEndings(source);
  const implementation = text.match(/\bCLASS\s+([A-Za-z0-9_\/]+)\s+IMPLEMENTATION\s*\.([\s\S]*)$/i);
  if (!implementation || implementation.index === undefined) return undefined;
  const className = implementation[1].toUpperCase();
  const definitionText = text.slice(0, implementation.index);
  const definition = definitionText.match(/^\s*CLASS\s+([A-Za-z0-9_\/]+)\s+DEFINITION\b([\s\S]*?)\bENDCLASS\s*\.\s*$/i);
  if (!definition || definition[1].toUpperCase() !== className) return undefined;
  const header = definition[2];
  if (!/\bPUBLIC\b/i.test(header) || !/\bFINAL\b/i.test(header) || !/\bCREATE\s+PUBLIC\b/i.test(header)) {
    return undefined;
  }
  const headerTerminator = header.search(/\./);
  if (headerTerminator < 0) return undefined;
  const definitionBody = header.slice(headerTerminator + 1)
    .replace(/\bPUBLIC\s+SECTION\s*\./ig, '')
    .replace(/\bPROTECTED\s+SECTION\s*\./ig, '')
    .replace(/\bPRIVATE\s+SECTION\s*\./ig, '')
    .replace(/\s+/g, '');
  if (definitionBody !== '') return undefined;
  const implementationTail = implementation[2];
  const implementationBody = implementationTail.match(/^([\s\S]*?)\bENDCLASS\s*\.\s*$/i);
  if (!implementationBody) return undefined;
  if (implementationBody[1].replace(/\s+/g, '') !== '') return undefined;
  return [
    'CLASS ' + className + ' DEFINITION PUBLIC FINAL CREATE PUBLIC.',
    'ENDCLASS.',
    'CLASS ' + className + ' IMPLEMENTATION.',
    'ENDCLASS.'
  ].join('\n');
}

function normalizeDdicStructureClosingBlank(source: string): string | undefined {
  const lines = normalizeLineEndings(source).split('\n');
  if (lines.length < 2 || lines.at(-1)?.trim() !== '}') return undefined;
  if (!/\bdefine\s+structure\s+[A-Za-z0-9_\/]+\s*\{/i.test(lines.join('\n'))) return undefined;
  if (lines.at(-2)?.trim() === '') lines.splice(-2, 1);
  return lines.join('\n');
}

function normalizeFunctionModuleSignatureSeparator(source: string): string | undefined {
  const normalizedSource = normalizeLineEndings(source);
  const lines = normalizedSource.split('\n');
  const firstContentLine = lines.findIndex(line => line.trim().length > 0);
  if (firstContentLine < 0 || !/^FUNCTION\s+\S+/i.test(lines[firstContentLine].trim())) return undefined;

  // Eclipse's function-module template places its explanatory comment before
  // a standalone signature terminator. Normalize that layout to the ordinary
  // `FUNCTION name.` header while preserving the comment and body.
  const header = lines[firstContentLine].match(/^(\s*FUNCTION\s+\S+)\s*$/i);
  if (header) {
    let terminator = firstContentLine + 1;
    while (terminator < lines.length && lines[terminator].trim().length === 0) terminator++;
    while (terminator < lines.length && lines[terminator].trim().startsWith('"')) terminator++;
    while (terminator < lines.length && lines[terminator].trim().length === 0) terminator++;
    if (terminator < lines.length && lines[terminator].trim() === '.') {
      lines[firstContentLine] = `${header[1]}.`;
      lines.splice(terminator, 1);
    }
  }

  // Eclipse inserts this fixed, user-facing parameter-template hint into a
  // parameterless module. It is SAP-owned scaffolding, not caller source.
  for (let index = lines.length - 1; index > firstContentLine; index--) {
    if (/You can use the template 'functionModuleParameter' to add here the signature!/i.test(lines[index])) {
      lines.splice(index, 1);
    }
  }

  let lastContentLine = lines.length - 1;
  while (lastContentLine >= 0 && lines[lastContentLine].trim().length === 0) lastContentLine--;
  if (lastContentLine <= firstContentLine || !/^ENDFUNCTION\.$/i.test(lines[lastContentLine].trim())) return undefined;

  let signatureEnd = -1;
  for (let index = firstContentLine; index < lastContentLine; index++) {
    const trimmedLine = lines[index].trim();
    if (!trimmedLine.startsWith('*')
      && !trimmedLine.startsWith('"')
      && trimmedLine.endsWith('.')) {
      signatureEnd = index;
      break;
    }
  }
  if (signatureEnd < 0) return undefined;

  let bodyStart = signatureEnd + 1;
  while (bodyStart < lastContentLine && lines[bodyStart].length === 0) bodyStart++;
  if (bodyStart >= lastContentLine) {
    return [...lines.slice(0, signatureEnd + 1), ...lines.slice(lastContentLine)].join('\n');
  }

  // SAP may choose a different number of blank separator lines after the signature.
  return [...lines.slice(0, signatureEnd + 1), '', ...lines.slice(bodyStart)].join('\n');
}

function normalizeFunctionModuleFormatting(source: string): string | undefined {
  const signatureNormalized = normalizeFunctionModuleSignatureCase(source);
  return signatureNormalized === undefined
    ? undefined
    : normalizeFunctionModuleSignatureSeparator(signatureNormalized) || normalizeLineEndings(signatureNormalized);
}

function normalizeFunctionModuleSignatureCase(source: string): string | undefined {
  const normalizedSource = normalizeLineEndings(source);
  const lines = normalizedSource.split('\n');
  const firstContentLine = lines.findIndex(line => line.trim().length > 0);
  if (firstContentLine < 0) return undefined;
  const match = lines[firstContentLine].match(/^(\s*)FUNCTION(\s+)([A-Za-z0-9_/]+)(\s*(?:\.\s*)?)$/i);
  if (!match) return undefined;
  lines[firstContentLine] = `${match[1]}FUNCTION${match[2]}${match[3].toUpperCase()}${match[4]}`;
  return lines.join('\n');
}
