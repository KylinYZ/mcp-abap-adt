import { applyToolArgumentLimits, assertReadOnlyQuery, assertToolResponseSize } from '../lib/requestLimits';

const guardrails = {
  queryDefaultRows: 200,
  queryMaxRows: 5000,
  searchDefaultResults: 50,
  searchMaxResults: 500,
  maxArgumentBytes: 1024
};

describe('request limits', () => {
  it.each([
    ['tableContents', 'rowNumber', 200],
    ['runQuery', 'rowNumber', 200],
    ['searchObject', 'max', 50],
    ['readRuntimeDumps', 'limit', 20]
  ] as const)
  ('adds the configured default for %s', (toolName, field, expected) => {
    const argumentsValue = toolName === 'runQuery' ? { sqlQuery: 'SELECT * FROM z_demo' } : {};
    expect(applyToolArgumentLimits(toolName, argumentsValue, guardrails)).toMatchObject({ [field]: expected });
  });

  it('keeps valid values and does not mutate the original arguments', () => {
    const original = { rowNumber: 25, sqlQuery: 'SELECT *' };
    const result = applyToolArgumentLimits('runQuery', original, guardrails);
    expect(result).toEqual(original);
    expect(result).not.toBe(original);
  });

  it.each([0, -1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY, 5001])('rejects invalid row limit %p', value => {
    expect(() => applyToolArgumentLimits('tableContents', { rowNumber: value }, guardrails)).toThrow('rowNumber');
  });

  it('does not change unrelated tools', () => {
    expect(applyToolArgumentLimits('healthcheck', { value: 1 }, guardrails)).toEqual({ value: 1 });
  });

  it('rejects mutating and multi-statement queries', () => {
    expect(() => assertReadOnlyQuery('runQuery', 'UPDATE z_demo SET value = 1')).toThrow('read-only');
    expect(() => assertReadOnlyQuery('runQuery', 'SELECT * FROM z_demo; DELETE FROM z_demo')).toThrow('one read-only SQL statement');
    expect(() => assertReadOnlyQuery('runQuery', 'SELECT * FROM z_demo')).not.toThrow();
    expect(() => assertReadOnlyQuery('tableContents', undefined)).not.toThrow();
  });

  it('rejects oversized UTF-8 arguments before dispatch', () => {
    expect(() => applyToolArgumentLimits(
      'previewAbapObjectCreation',
      { objects: [{ source: '中'.repeat(400) }] },
      guardrails
    )).toThrow('request limit');
  });

  it('rejects batch-shaped or oversized safe debug arguments', () => {
    expect(() => applyToolArgumentLimits('executeDebugCommand', { command: [] }, guardrails)).toThrow('one command object');
    expect(() => applyToolArgumentLimits('previewDebugVariableChange', { parents: Array(21).fill('@ROOT') }, guardrails))
      .toThrow('20 scopes');
    expect(() => applyToolArgumentLimits('previewDebugOperation', {
      operation: { kind: 'SET_BREAKPOINTS', breakpoints: Array(51).fill({}) }
    }, guardrails)).toThrow('50 breakpoints');
  });

  it('rejects unexpected fields and malformed bounded identifiers for advanced tools', () => {
    const roomy = { ...guardrails, maxArgumentBytes: 1_000_000 };
    expect(() => applyToolArgumentLimits('rapGenPublishService', { srvbName: 'ZSRV', methodName: 'arbitrary' }, roomy))
      .toThrow('does not accept fields');
    expect(() => applyToolArgumentLimits('objectStructureElements', { objectUrl: '/bad\nurl' }, roomy))
      .toThrow('control characters');
    expect(() => applyToolArgumentLimits('rapGenGenerate', {
      genId: 'uiservice', refObjectUri: '/ref', transport: 'X'.repeat(256), content: {}
    }, roomy)).toThrow('transport');
    expect(() => applyToolArgumentLimits('rapGenPublishService', { srvbName: 42 }, roomy)).toThrow('srvbName');
  });

  it('rejects raw query or SQL fields on high-level read tools', () => {
    expect(() => applyToolArgumentLimits('readRuntimeDumps', {
      from: '2026-08-16T00:00:00+08:00',
      to: '2026-08-16T01:00:00+08:00',
      query: 'and ( equals ( user , ADMIN ) )'
    }, guardrails)).toThrow('does not accept fields');
    expect(() => applyToolArgumentLimits('describeClassicTable', {
      tableName: 'T000',
      sqlQuery: 'SELECT * FROM T000'
    }, guardrails)).toThrow('does not accept fields');
    expect(() => applyToolArgumentLimits('inspectSapSystem', { url: '/sap/bc/adt/discovery' }, guardrails))
      .toThrow('does not accept fields');
    expect(() => applyToolArgumentLimits('getAbapMemberSource', {
      objectType: 'CLASS', objectName: 'ZCL_DEMO', memberName: 'RUN', sourceUrl: '/arbitrary'
    }, guardrails)).toThrow('does not accept fields');
    expect(() => applyToolArgumentLimits('readRuntimeDumps', {
      from: '2026-08-16T00:00:00+08:00',
      to: '2026-08-16T01:00:00+08:00',
      limit: 51
    }, guardrails)).toThrow('limit');
  });

  it('enforces bounded arrays and JSON structure for advanced operations', () => {
    const roomy = { ...guardrails, maxArgumentBytes: 10_000_000 };
    expect(() => applyToolArgumentLimits('rapGenValidateInitial', {
      genId: 'uiservice', refObjectUri: '/ref', packageName: 'ZPKG', checks: Array(17).fill('AUTH')
    }, roomy)).toThrow('bounded string-array');
    expect(() => applyToolArgumentLimits('rapGenValidateInitial', {
      genId: 'uiservice', refObjectUri: '/ref', packageName: 'ZPKG', checks: ['X'.repeat(65)]
    }, roomy)).toThrow('bounded string-array');
    expect(() => applyToolArgumentLimits('setTextElements', {
      url: '/text', category: 'symbols', elements: {}, lockHandle: 'lock'
    }, roomy)).toThrow('500 entries');
    expect(() => applyToolArgumentLimits('setTextElements', {
      url: '/text', category: 'symbols', elements: Array(501).fill('x'), lockHandle: 'lock'
    }, roomy)).toThrow('500 entries');

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 10; index += 1) deep = { nested: deep };
    expect(() => applyToolArgumentLimits('rapGenPreview', { genId: 'uiservice', refObjectUri: '/ref', content: deep }, roomy))
      .toThrow('eight nested levels');
    expect(() => applyToolArgumentLimits('rapGenPreview', {
      genId: 'uiservice', refObjectUri: '/ref', content: { items: Array(501).fill(null) }
    }, roomy)).toThrow('500 entries');
    expect(() => applyToolArgumentLimits('rapGenPreview', {
      genId: 'uiservice', refObjectUri: '/ref', content: Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`k${index}`, index]))
    }, roomy)).toThrow('500 keys');
    expect(() => applyToolArgumentLimits('rapGenPreview', {
      genId: 'uiservice', refObjectUri: '/ref', content: { scalar: 'allowed', nested: [1, true, null] }
    }, roomy)).not.toThrow();
  });

  it('rejects unbounded or unexpected quality-check input', () => {
    const roomy = { ...guardrails, maxArgumentBytes: 1_000_000 };
    expect(() => applyToolArgumentLimits('previewQualityCheck', {
      kind: 'ABAP_UNIT', objects: []
    }, roomy)).toThrow('one and twenty');
    expect(() => applyToolArgumentLimits('previewQualityCheck', {
      kind: 'ABAP_UNIT', objects: Array(21).fill({ objectType: 'CLASS', objectName: 'ZCL_TEST' })
    }, roomy)).toThrow('one and twenty');
    expect(() => applyToolArgumentLimits('previewQualityCheck', {
      kind: 'ABAP_UNIT', objects: [{ objectType: 'CLASS', objectName: 'ZCL_TEST' }], mainUrl: '/arbitrary'
    }, roomy)).toThrow('does not accept fields');
    expect(() => applyToolArgumentLimits('runQualityCheck', {
      qualityPlanId: 'plan', confirmedByUser: true
    }, roomy)).toThrow('does not accept fields');
  });

  it('rejects empty or non-query SQL while ignoring keywords inside literals and comments', () => {
    expect(() => assertReadOnlyQuery('runQuery', '')).toThrow('read-only query');
    expect(() => assertReadOnlyQuery('runQuery', 'DESCRIBE z_demo')).toThrow('SELECT or WITH');
    expect(() => assertReadOnlyQuery('runQuery', "SELECT 'DELETE' AS text FROM z_demo -- UPDATE ignored"))
      .not.toThrow();
    expect(() => assertReadOnlyQuery('runQuery', 'SELECT * FROM z_demo /* DROP ignored */')).not.toThrow();
  });

  it('ignores non-tool-result response shapes', () => {
    expect(() => assertToolResponseSize(undefined, 1)).not.toThrow();
    expect(() => assertToolResponseSize({ content: 'not-an-array' }, 1)).not.toThrow();
    expect(() => assertToolResponseSize({ content: [{ type: 'image', data: 'large' }] }, 1)).not.toThrow();
  });

  it('counts UTF-8 bytes across text items and ignores non-text items', () => {
    expect(() => assertToolResponseSize({ content: [{ type: 'text', text: '中' }, { type: 'image', data: 'large' }] }, 3))
      .not.toThrow();
    expect(() => assertToolResponseSize({ content: [{ type: 'text', text: '中' }, { type: 'text', text: 'a' }] }, 3))
      .toThrow('response limit');
  });

  it('counts structured content in addition to visible text', () => {
    expect(() => assertToolResponseSize({
      content: [{ type: 'text', text: 'a' }],
      structuredContent: { diff: '中' }
    }, 15)).not.toThrow();
    expect(() => assertToolResponseSize({
      content: [{ type: 'text', text: 'a' }],
      structuredContent: { diff: '中' }
    }, 14)).toThrow('response limit');
  });

  it('does not include rejected response content in the error', () => {
    const secret = 'SECRET_RESPONSE';
    expect(() => assertToolResponseSize({ content: [{ type: 'text', text: secret }] }, 1)).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(secret) })
    );
  });
});
