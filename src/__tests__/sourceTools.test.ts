import {
  compareAbapClassSources,
  compareDdicStructureSources,
  compareFunctionModuleSources,
  compareSources,
  createUnifiedDiff,
  safeSourceMismatchSummary,
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

  it('accepts the Eclipse parameter-template scaffold and standalone signature terminator', () => {
    const expected = [
      'FUNCTION zmcp_test001.',
      '',
      'WRITE \'12\'.',
      '',
      '',
      'ENDFUNCTION.'
    ].join('\n');
    const actual = [
      'FUNCTION ZMCP_TEST001',
      '  " You can use the template \'functionModuleParameter\' to add here the signature!',
      '.',
      '',
      'WRITE \'12\'.',
      '',
      '',
      'ENDFUNCTION.'
    ].join('\r\n');

    expect(compareFunctionModuleSources(expected, actual)).toMatchObject({
      matchType: 'FUNCTION_MODULE_FORMAT_NORMALIZED',
      matches: true
    });
  });

  it('accepts the Eclipse scaffold for an empty function-module implementation', () => {
    const expected = [
      'FUNCTION zvpfgi12a.',
      'ENDFUNCTION.'
    ].join('\n');
    const actual = [
      'FUNCTION ZVPFGI12A',
      '  " You can use the template \'functionModuleParameter\' to add here the signature!',
      '.',
      'ENDFUNCTION.'
    ].join('\r\n');

    expect(compareFunctionModuleSources(expected, actual)).toMatchObject({
      matchType: 'FUNCTION_MODULE_FORMAT_NORMALIZED',
      matches: true
    });
  });

  it('accepts SAP uppercasing the function-module signature', () => {
    const expected = 'FUNCTION z_test.\n  WRITE \'ok\'.\nENDFUNCTION.';
    const actual = 'FUNCTION Z_TEST.\r\n  WRITE \'ok\'.\r\nENDFUNCTION.';

    expect(compareFunctionModuleSources(expected, actual)).toMatchObject({
      matchType: 'FUNCTION_MODULE_FORMAT_NORMALIZED',
      matches: true
    });
  });

  it('reports source mismatch metadata without exposing either line', () => {
    const expected = 'FUNCTION z_test.\n  DATA(secret_expected) = 1.\nENDFUNCTION.';
    const actual = 'FUNCTION z_test.\n  DATA(secret_actual) = 2.\nENDFUNCTION.';
    const summary = safeSourceMismatchSummary(expected, actual);

    expect(summary).toMatchObject({
      expectedHash: sourceHash(expected), actualHash: sourceHash(actual),
      expectedLineCount: 3, actualLineCount: 3, firstMismatchLine: 2
    });
    expect(JSON.stringify(summary)).not.toContain('secret_expected');
    expect(JSON.stringify(summary)).not.toContain('secret_actual');
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

  it('accepts SAP pretty-print of an empty public final class', () => {
    const expected = [
      'CLASS zvpcl02 DEFINITION PUBLIC FINAL CREATE PUBLIC.',
      'ENDCLASS.',
      'CLASS zvpcl02 IMPLEMENTATION.',
      'ENDCLASS.'
    ].join('\n');
    const actual = [
      'class ZVPCL02 definition',
      '  public',
      '  final',
      '  create public .',
      '',
      'public section.',
      'protected section.',
      'private section.',
      'ENDCLASS.',
      '',
      '',
      '',
      'CLASS ZVPCL02 IMPLEMENTATION.',
      'ENDCLASS.'
    ].join('\r\n');

    expect(compareAbapClassSources(expected, actual)).toMatchObject({
      matchType: 'ABAP_CLASS_FORMAT_NORMALIZED',
      matches: true,
      expectedHash: sourceHash(expected),
      actualHash: sourceHash(actual)
    });
    expect(compareSources(expected, actual)).toMatchObject({ matchType: 'DIFFERENT', matches: false });
  });

  it('accepts one SAP-inserted blank line immediately before a DDIC structure closing brace', () => {
    const expected = [
      '@EndUserText.label : \'MCP\'',
      'define structure zvpstr05 {',
      '  test_text : abap.char(40);',
      '}'
    ].join('\n');
    const actual = [
      '@EndUserText.label : \'MCP\'',
      'define structure zvpstr05 {',
      '  test_text : abap.char(40);',
      '',
      '}'
    ].join('\r\n');

    expect(compareDdicStructureSources(expected, actual)).toMatchObject({
      matchType: 'DDIC_STRUCTURE_FORMAT_NORMALIZED',
      matches: true
    });
    expect(compareSources(expected, actual)).toMatchObject({ matchType: 'DIFFERENT', matches: false });
  });

  it('rejects DDIC structure differences beyond the closing-brace blank line', () => {
    const expected = 'define structure zvpstr05 {\n  test_text : abap.char(40);\n}';
    const actual = 'define structure zvpstr05 {\n  test_text : abap.char(41);\n\n}';
    expect(compareDdicStructureSources(expected, actual)).toMatchObject({ matchType: 'DIFFERENT', matches: false });
  });

  it.each([
    ['class name', 'CLASS zother DEFINITION PUBLIC FINAL CREATE PUBLIC.\nENDCLASS.\nCLASS zother IMPLEMENTATION.\nENDCLASS.'],
    ['missing final', 'CLASS zvpcl02 DEFINITION PUBLIC CREATE PUBLIC.\nENDCLASS.\nCLASS zvpcl02 IMPLEMENTATION.\nENDCLASS.'],
    ['definition method', 'CLASS zvpcl02 DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zvpcl02 IMPLEMENTATION.\nENDCLASS.'],
    ['implementation body', 'CLASS zvpcl02 DEFINITION PUBLIC FINAL CREATE PUBLIC.\nENDCLASS.\nCLASS zvpcl02 IMPLEMENTATION.\n  METHOD run.\n  ENDMETHOD.\nENDCLASS.']
  ])('rejects class %s differences outside empty-skeleton formatting', (_caseName, actual) => {
    const expected = 'CLASS zvpcl02 DEFINITION PUBLIC FINAL CREATE PUBLIC.\nENDCLASS.\nCLASS zvpcl02 IMPLEMENTATION.\nENDCLASS.';
    expect(compareAbapClassSources(expected, actual)).toMatchObject({
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
