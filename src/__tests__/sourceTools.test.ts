import {
  compareFunctionModuleSources,
  compareSources,
  createUnifiedDiff,
  sourceHash
} from '../safe/sourceTools';

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

  it('accepts only SAP function-module signature separator formatting', () => {
    const expected = [
      'FUNCTION z_test',
      '  IMPORTING',
      '    VALUE(iv_input) TYPE string',
      '  EXPORTING',
      '    VALUE(ev_output) TYPE string.',
      '',
      '  ev_output = iv_input.',
      'ENDFUNCTION.'
    ].join('\n');
    const actual = [
      'FUNCTION z_test',
      '  IMPORTING',
      '    VALUE(iv_input) TYPE string',
      '  EXPORTING',
      '    VALUE(ev_output) TYPE string.',
      '',
      '',
      '',
      '  ev_output = iv_input.',
      'ENDFUNCTION.'
    ].join('\r\n');

    expect(compareFunctionModuleSources(expected, actual)).toMatchObject({
      matchType: 'FUNCTION_MODULE_FORMAT_NORMALIZED',
      matches: true,
      expectedHash: sourceHash(expected),
      actualHash: sourceHash(actual)
    });
    expect(compareSources(expected, actual)).toMatchObject({ matchType: 'DIFFERENT', matches: false });
  });

  it('supports signature separator formatting for a parameterless function module', () => {
    const expected = 'FUNCTION z_test.\n  DATA(result) = 1.\nENDFUNCTION.';
    const actual = 'FUNCTION z_test.\r\n\r\n\r\n  DATA(result) = 1.\r\nENDFUNCTION.';

    expect(compareFunctionModuleSources(expected, actual)).toMatchObject({
      matchType: 'FUNCTION_MODULE_FORMAT_NORMALIZED',
      matches: true
    });
  });

  it('does not mistake a signature comment ending in a period for the signature terminator', () => {
    const expected = 'FUNCTION z_test\n  " Parameter description.\n  IMPORTING\n    VALUE(iv_input) TYPE string.\n  DATA(result) = iv_input.\nENDFUNCTION.';
    const actual = 'FUNCTION z_test\r\n  " Parameter description.\r\n  IMPORTING\r\n    VALUE(iv_input) TYPE string.\r\n\r\n\r\n  DATA(result) = iv_input.\r\nENDFUNCTION.';

    expect(compareFunctionModuleSources(expected, actual)).toMatchObject({
      matchType: 'FUNCTION_MODULE_FORMAT_NORMALIZED',
      matches: true
    });
  });

  it.each([
    ['parameter type', 'FUNCTION z_test\n  IMPORTING\n    VALUE(iv_input) TYPE i.\n\n  ev_output = iv_input.\nENDFUNCTION.'],
    ['implementation', 'FUNCTION z_test\n  IMPORTING\n    VALUE(iv_input) TYPE string.\n\n  ev_output = `changed`.\nENDFUNCTION.'],
    ['comment', 'FUNCTION z_test\n  IMPORTING\n    VALUE(iv_input) TYPE string.\n\n  " changed\n  ev_output = iv_input.\nENDFUNCTION.'],
    ['indentation', 'FUNCTION z_test\n  IMPORTING\n    VALUE(iv_input) TYPE string.\n\n ev_output = iv_input.\nENDFUNCTION.'],
    ['body blank line', 'FUNCTION z_test\n  IMPORTING\n    VALUE(iv_input) TYPE string.\n\n  ev_output = iv_input.\n\n  DATA(result) = 1.\nENDFUNCTION.'],
    ['blank before end', 'FUNCTION z_test\n  IMPORTING\n    VALUE(iv_input) TYPE string.\n\n  ev_output = iv_input.\n\nENDFUNCTION.'],
    ['incomplete frame', 'FUNCTION z_test\n  IMPORTING\n    VALUE(iv_input) TYPE string.\n\n  ev_output = iv_input.']
  ])('rejects %s differences outside the signature separator', (_caseName, actual) => {
    const expected = 'FUNCTION z_test\n  IMPORTING\n    VALUE(iv_input) TYPE string.\n\n  ev_output = iv_input.\nENDFUNCTION.';

    expect(compareFunctionModuleSources(expected, actual)).toMatchObject({
      matchType: 'DIFFERENT',
      matches: false
    });
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
