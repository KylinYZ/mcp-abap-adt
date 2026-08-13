import { compareSources, createUnifiedDiff, sourceHash } from '../safe/sourceTools';

describe('source tools', () => {
  it('creates stable SHA-256 hashes', () => {
    expect(sourceHash('REPORT ztest.')).toHaveLength(64);
    expect(sourceHash('REPORT ztest.')).toBe(sourceHash('REPORT ztest.'));
  });

  it('classifies exact, line-ending-normalized, and different source', () => {
    expect(compareSources('A\nB', 'A\nB')).toMatchObject({ matchType: 'EXACT', matches: true });
    expect(compareSources('A\r\nB\r\n', 'A\nB')).toMatchObject({
      matchType: 'LINE_ENDING_NORMALIZED',
      matches: true
    });
    expect(compareSources('A\rB', 'A\nB\n\n')).toMatchObject({
      matchType: 'LINE_ENDING_NORMALIZED',
      matches: true
    });
    expect(compareSources('A B', 'A  B')).toMatchObject({ matchType: 'DIFFERENT', matches: false });
    expect(compareSources('* comment', '* changed')).toMatchObject({ matchType: 'DIFFERENT', matches: false });
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
