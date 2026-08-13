import { applyToolArgumentLimits, assertToolResponseSize } from '../lib/requestLimits';

const guardrails = { queryDefaultRows: 200, queryMaxRows: 5000, searchDefaultResults: 50, searchMaxResults: 500 };

describe('request limits', () => {
  it.each([['tableContents', 'rowNumber', 200], ['runQuery', 'rowNumber', 200], ['searchObject', 'max', 50]] as const)
  ('adds the configured default for %s', (toolName, field, expected) => {
    expect(applyToolArgumentLimits(toolName, {}, guardrails)).toMatchObject({ [field]: expected });
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

  it('counts UTF-8 bytes across text items and ignores non-text items', () => {
    expect(() => assertToolResponseSize({ content: [{ type: 'text', text: '中' }, { type: 'image', data: 'large' }] }, 3))
      .not.toThrow();
    expect(() => assertToolResponseSize({ content: [{ type: 'text', text: '中' }, { type: 'text', text: 'a' }] }, 3))
      .toThrow('response limit');
  });

  it('does not include rejected response content in the error', () => {
    const secret = 'SECRET_RESPONSE';
    expect(() => assertToolResponseSize({ content: [{ type: 'text', text: secret }] }, 1)).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(secret) })
    );
  });
});
