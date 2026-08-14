import type { Dump } from '../adt/index.js';
import { analyzeRuntimeErrors } from '../sm21/runtimeAnalysis';
import type { Sm21LogEntry } from '../sm21/types';

const dump: Dump = {
  id: 'dump-1', categories: [], links: [], author: 'DEV_USER', text: 'Runtime error in Z_ORDER_CREATE executed by DEV_USER', type: 'text'
};
const log: Sm21LogEntry = {
  timestamp: '20260813080000', instance: 'APP01', client: '100', user: 'DEV_USER', program: 'Z_ORDER_CREATE', tcode: 'ZORD', messageId: 'TH', severity: 'ERROR', process: '001', text: 'Program terminated'
};

describe('runtime error analysis', () => {
  it('reports strong evidence only for multiple independent identifiers', () => {
    const result = analyzeRuntimeErrors([dump], [log], false);
    expect(result.correlations[0]).toMatchObject({ evidence: 'strong', sm21Indexes: [0], matchedFields: ['program', 'user'] });
    expect(result.uncorrelatedSm21Indexes).toEqual([]);
  });

  it('reports a single text match only as a candidate and preserves partial limits', () => {
    const result = analyzeRuntimeErrors([{ ...dump, text: 'Runtime error in Z_ORDER_CREATE', author: undefined }], [log], true);
    expect(result.correlations[0]).toMatchObject({ evidence: 'candidate', sm21Indexes: [0] });
    expect(result.partial).toBe(true);
    expect(result.limitations.join(' ')).toContain('partial observations');
  });

  it('does not report a correlation without identifiers', () => {
    const result = analyzeRuntimeErrors([{ ...dump, text: 'Generic runtime error', author: undefined }], [log], false);
    expect(result.correlations[0]).toMatchObject({ evidence: 'none', sm21Indexes: [] });
    expect(result.uncorrelatedSm21Indexes).toEqual([0]);
  });
});
