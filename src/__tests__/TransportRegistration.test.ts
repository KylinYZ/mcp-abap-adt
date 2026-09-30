import {
  assertTrkorrToken,
  cellText,
  classifyTransportError,
  e070HeaderQuery,
  e070TaskQuery,
  e071EntriesQuery,
  flattenAdtTransportObjects,
  isReleasedStatus,
  matchTransportRegistration
} from '../safe/TransportRegistration';

describe('TransportRegistration（7.51 兼容纯函数层）', () => {
  it('classifies the 7.51 URI-mapping gap and common failure shapes', () => {
    expect(classifyTransportError(new Error('No URI-Mapping defined for URI /sap/bc/adt/packages/z001')))
      .toBe('URI_MAPPING_UNAVAILABLE');
    expect(classifyTransportError(new Error('Resource /sap/bc/adt/cts/transportrequests not found (404)')))
      .toBe('RESOURCE_NOT_FOUND');
    expect(classifyTransportError(new Error('403 Forbidden'))).toBe('AUTHORIZATION');
    expect(classifyTransportError(new Error('connection ETIMEDOUT'))).toBe('TIMEOUT');
    expect(classifyTransportError(new Error('socket hang up'))).toBe('OTHER');
  });

  it('flattens ADT request objects across the request and all its tasks', () => {
    const entries = flattenAdtTransportObjects({
      'tm:number': 'ED1K925158',
      'tm:status': 'modifiable',
      objects: [{ 'tm:pgmid': 'R3TR', 'tm:type': 'PROG', 'tm:name': 'ZR_X' }],
      tasks: [{
        'tm:number': 'ED1K925159',
        'tm:status': 'modifiable',
        objects: [{ 'tm:pgmid': 'LIMU', 'tm:type': 'REPS', 'tm:name': 'ZR_X' }],
        links: []
      }],
      links: []
    } as never);
    expect(entries).toEqual([
      { pgmid: 'R3TR', object: 'PROG', name: 'ZR_X' },
      { pgmid: 'LIMU', object: 'REPS', name: 'ZR_X' }
    ]);
    expect(flattenAdtTransportObjects(undefined)).toEqual([]);
  });

  it('matches strict registration entries per object kind', () => {
    const entries = [
      { pgmid: 'R3TR', object: 'PROG', name: 'ZNEW' },
      { pgmid: 'LIMU', object: 'FUNC', name: 'ZNEW_FM' }
    ];
    expect(matchTransportRegistration(entries, 'PROGRAM', 'znew')).toBe('PROVEN');
    expect(matchTransportRegistration(entries, 'FUNCTION_MODULE', 'ZNEW_FM', 'ZFG')).toBe('PROVEN');
    // 大小写不敏感：SAP 端名字大小写差异不影响判定。
    expect(matchTransportRegistration([{ pgmid: 'LIMU', object: 'INC', name: 'lzfgtop' }], 'FUNCTION_GROUP_INCLUDE', 'LZFGTOP', 'ZFG'))
      .toBe('PROVEN');
    // 名字相同但条目类型不符 → 不算证明（防止同名异类对象的假阳性）。
    expect(matchTransportRegistration([{ pgmid: 'R3TR', object: 'TABL', name: 'ZNEW' }], 'PROGRAM', 'ZNEW'))
      .toBe('UNPROVEN');
  });

  it('falls back to the parent function group entry for function module and include kinds', () => {
    const groupOnly = [{ pgmid: 'R3TR', object: 'FUGR', name: 'ZFG' }];
    expect(matchTransportRegistration(groupOnly, 'FUNCTION_MODULE', 'ZNEW_FM', 'ZFG')).toBe('PROVEN_VIA_GROUP');
    expect(matchTransportRegistration(groupOnly, 'FUNCTION_GROUP_INCLUDE', 'LZFGTOP', 'ZFG')).toBe('PROVEN_VIA_GROUP');
    // 程序没有父组放宽：组条目不能证明独立程序。
    expect(matchTransportRegistration(groupOnly, 'PROGRAM', 'ZNEW', 'ZFG')).toBe('UNPROVEN');
    // 父组名不匹配时同样不算证明。
    expect(matchTransportRegistration(groupOnly, 'FUNCTION_MODULE', 'ZNEW_FM', 'ZOTHER')).toBe('UNPROVEN');
  });

  it('detects released statuses in both ADT and E070 shapes', () => {
    expect(isReleasedStatus('R')).toBe(true);
    expect(isReleasedStatus('released')).toBe(true);
    expect(isReleasedStatus('D')).toBe(false);
    expect(isReleasedStatus('modifiable')).toBe(false);
    expect(isReleasedStatus('')).toBe(false);
  });

  it('builds bounded SQL with quoted tokens and rejects malformed TRKORR', () => {
    expect(e070HeaderQuery('ED1K925158')).toBe("SELECT trkorr, trstatus, as4user FROM e070 WHERE trkorr = 'ED1K925158'");
    expect(e070TaskQuery('ED1K925158')).toBe("SELECT trkorr FROM e070 WHERE strkorr = 'ED1K925158'");
    expect(e071EntriesQuery(['ED1K925158', 'ED1K925159']))
      .toBe("SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr IN ('ED1K925158', 'ED1K925159')");
    expect(() => assertTrkorrToken('ED1K9251; DROP TABLE e071')).toThrow('TRKORR');
    expect(() => e070HeaderQuery('short')).toThrow('TRKORR');
  });

  it('reads datapreview cells tolerantly regardless of column name case', () => {
    expect(cellText({ TRSTATUS: 'D' }, 'trstatus')).toBe('D');
    expect(cellText({ 'e070~TRSTATUS': 'R' }, 'trstatus')).toBe('R');
    expect(cellText({ OTHER: 'x' }, 'trstatus')).toBe('');
    expect(cellText({ TRSTATUS: null }, 'trstatus')).toBe('');
  });
});
