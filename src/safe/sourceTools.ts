import { createHash } from 'crypto';
import type { DiffSummary } from './types.js';

export function sourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
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
