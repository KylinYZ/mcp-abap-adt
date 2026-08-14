import { applyToolArgumentLimits, assertReadOnlyQuery, assertToolResponseSize } from '../lib/requestLimits';

const guardrails = {
  queryDefaultRows: 200,
  queryMaxRows: 5000,
  searchDefaultResults: 50,
  searchMaxResults: 500,
  maxArgumentBytes: 1024
};

describe('request limits', () => {
  it.each([['tableContents', 'rowNumber', 200], ['runQuery', 'rowNumber', 200], ['searchObject', 'max', 50]] as const)
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
