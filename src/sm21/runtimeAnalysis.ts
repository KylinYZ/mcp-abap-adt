import type { Dump } from 'abap-adt-api';
import type { Sm21LogEntry } from './types.js';

export type EvidenceLevel = 'strong' | 'candidate' | 'none';

export interface RuntimeErrorCorrelation {
  dumpId: string;
  sm21Indexes: number[];
  evidence: EvidenceLevel;
  matchedFields: string[];
  note: string;
}

export interface RuntimeErrorAnalysis {
  correlations: RuntimeErrorCorrelation[];
  uncorrelatedSm21Indexes: number[];
  partial: boolean;
  limitations: string[];
}

export function analyzeRuntimeErrors(dumps: Dump[], sm21Logs: Sm21LogEntry[], partial: boolean): RuntimeErrorAnalysis {
  const correlations = dumps.map(dump => correlateDump(dump, sm21Logs));
  const matchedIndexes = new Set(correlations.flatMap(correlation => correlation.sm21Indexes));
  return {
    correlations,
    uncorrelatedSm21Indexes: sm21Logs.map((_, index) => index).filter(index => !matchedIndexes.has(index)),
    partial,
    limitations: [
      'ADT dump summaries do not expose a stable structured timestamp in the current dependency.',
      'Correlations are text-based evidence only and do not prove that an SM21 event caused an ST22 dump.',
      ...(partial ? ['SM21 results are paged or truncated; conclusions are based on partial observations.'] : [])
    ]
  };
}

function correlateDump(dump: Dump, logs: Sm21LogEntry[]): RuntimeErrorCorrelation {
  const haystack = `${dump.id} ${dump.text} ${dump.author || ''}`.toUpperCase();
  const matching = logs.map((log, index) => ({ index, fields: matchingFields(haystack, log) })).filter(item => item.fields.length > 0);
  const strong = matching.filter(item => item.fields.length >= 2);
  const selected = strong.length > 0 ? strong : matching;
  const matchedFields = [...new Set(selected.flatMap(item => item.fields))];
  return {
    dumpId: dump.id,
    sm21Indexes: selected.map(item => item.index),
    evidence: strong.length > 0 ? 'strong' : selected.length > 0 ? 'candidate' : 'none',
    matchedFields,
    note: strong.length > 0
      ? 'Two or more independent identifiers overlap between the dump summary and SM21 entry.'
      : selected.length > 0
        ? 'One identifier overlaps between the dump summary and SM21 entry; inspect the source records before drawing a conclusion.'
        : 'No supported identifier overlaps between this dump summary and the returned SM21 entries.'
  };
}

function matchingFields(haystack: string, log: Sm21LogEntry): string[] {
  const candidates: Array<[string, string]> = [
    ['program', log.program],
    ['user', log.user],
    ['transaction', log.tcode],
    ['instance', log.instance],
    ['messageId', log.messageId]
  ];
  return candidates
    .filter(([, value]) => value.length >= 3 && haystack.includes(value.toUpperCase()))
    .map(([field]) => field);
}
