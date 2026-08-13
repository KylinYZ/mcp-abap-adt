import { createHash } from 'crypto';
import type { DiffSummary, SourceMatchType } from './types.js';

export interface SourceComparison {
  matches: boolean;
  matchType: SourceMatchType;
  expectedHash: string;
  actualHash: string;
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
