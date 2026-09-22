// 文本元素协议层格式测试：S/4 真机实测的 @MaxLength 每符号指令布局（DS512 一致性要求）
import { formatTextElements, parseTextElements, textElementsUrl } from '../adt/api/textelements';

describe('textelements plain format (S/4 DS512 verified)', () => {
  it('emits one @MaxLength directive per symbol, defaulting to 132', () => {
    const body = formatTextElements(
      [{ id: '001', text: 'Probe first text' }, { id: '002', text: 'Probe second text', maxLength: 60 }],
      'symbols'
    );
    expect(body).toBe('@MaxLength:132\n001=Probe first text\n\n@MaxLength:60\n002=Probe second text\n');
  });

  it('round-trips symbols through parse with the directive preserved', () => {
    const body = formatTextElements([{ id: '001', text: 'Hello', maxLength: 132 }], 'symbols');
    const parsed = parseTextElements(body);
    expect(parsed).toEqual([{ id: '001', text: 'Hello', maxLength: 132 }]);
  });

  it('keeps selections and headings layouts unchanged', () => {
    expect(formatTextElements([{ id: 'P_BUKRS', text: 'Company Code' }], 'selections'))
      .toBe('P_BUKRS=Company Code\n');
    expect(formatTextElements([{ id: 'LISTHEADER', text: 'Report Title' }], 'headings'))
      .toBe('LISTHEADER=Report Title');
  });

  it('builds the text pool subresource URL per object type', () => {
    expect(textElementsUrl('PROG/P', 'ZTXTPOOL')).toBe('/sap/bc/adt/textelements/programs/ztxtpool');
    expect(textElementsUrl('CLAS/OC', 'ZCL_DEMO')).toBe('/sap/bc/adt/textelements/classes/zcl_demo');
  });
});
