import { createUnifiedDiff, sourceHash } from '../safe/sourceTools';

describe('source tools', () => {
  it('creates stable SHA-256 hashes', () => {
    expect(sourceHash('REPORT ztest.')).toHaveLength(64);
    expect(sourceHash('REPORT ztest.')).toBe(sourceHash('REPORT ztest.'));
  });

  it('creates a complete replacement diff for the changed region', () => {
    const result = createUnifiedDiff('A\nB\nC', 'A\nX\nC');
    expect(result.diff).toContain('-B');
    expect(result.diff).toContain('+X');
    expect(result.summary).toEqual({
      addedLines: 1,
      removedLines: 1,
      unchangedPrefixLines: 1,
      unchangedSuffixLines: 1
    });
  });
});
