/**
 * transports.ts transportDetails 解析回归：真机 XML（sap-demo 2026-09-30 实证）
 * 把请求的对象条目放在 <tm:all_objects> 包装元素下，且条目属性无 tm:obj_func。
 * 此前解析器只找 tm:request 直接子级的 tm:abap_object，objects 恒为空数组，
 * 导致受控清理链的传输证据核验必然 VERIFICATION_FAILED（详见
 * docs/evidence/full-workflow-smoke-verified.md 的发现 D3）。
 */
import { transportDetails } from '../adt/api/transports';

// 真机抓包节选：请求 S4HK900029 + 自动子任务 S4HK900030 + tm:all_objects 包装条目
const REAL_SHAPE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tm:root xmlns:tm="http://www.sap.com/cts/transportorganizer" xmlns:atom="http://www.w3.org/2005/Atom">
  <tm:request tm:number="S4HK900029" tm:parent="" tm:owner="68157" tm:type="K" tm:status="D"
    tm:uri="/sap/bc/adt/cts/transportrequests/S4HK900029">
    <atom:link href="/sap/bc/adt/cts/transportrequests/S4HK900029" rel="self"/>
    <tm:task tm:number="S4HK900030" tm:parent="S4HK900029" tm:owner="68157" tm:type="Development/Correction"
      tm:status="D" tm:uri="/sap/bc/adt/cts/transportrequests/S4HK900030">
      <atom:link href="/sap/bc/adt/cts/transportrequests/S4HK900030" rel="self"/>
    </tm:task>
    <tm:all_objects>
      <tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZPRGWF0447" tm:wbtype="PROG/P"
        tm:position="000001" tm:lock_status="X" tm:img_activity="">
        <atom:link href="/sap/bc/adt/cts/transportrequests/S4HK900030" rel="removeobject"/>
      </tm:abap_object>
      <tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZPRGWF0864" tm:wbtype="PROG/P"
        tm:position="000002" tm:lock_status="X" tm:img_activity=""/>
    </tm:all_objects>
  </tm:request>
</tm:root>`;

describe('transportDetails 解析（tm:all_objects 真机形态回归）', () => {
  it('从 tm:all_objects 包装元素解析出请求级对象条目', async () => {
    const h = { request: jest.fn(async () => ({ body: REAL_SHAPE_XML })) } as unknown as Parameters<typeof transportDetails>[0];
    const details = await transportDetails(h, 'S4HK900029');
    expect(details.objects).toHaveLength(2);
    expect(details.objects[0]['tm:pgmid']).toBe('R3TR');
    expect(details.objects[0]['tm:type']).toBe('PROG');
    expect(details.objects[0]['tm:name']).toBe('ZPRGWF0447');
    expect(details.objects[1]['tm:name']).toBe('ZPRGWF0864');
    expect(details.tasks).toHaveLength(1);
    expect(details.tasks[0]['tm:number']).toBe('S4HK900030');
  });

  it('兼容旧形态：直接子级 tm:abap_object 仍然解析', async () => {
    const legacyXml = `<?xml version="1.0"?>
      <tm:root xmlns:tm="http://www.sap.com/cts/transportorganizer">
        <tm:request tm:number="DEVK900001" tm:status="D">
          <tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZOLD"/>
        </tm:request>
      </tm:root>`;
    const h = { request: jest.fn(async () => ({ body: legacyXml })) } as unknown as Parameters<typeof transportDetails>[0];
    const details = await transportDetails(h, 'DEVK900001');
    expect(details.objects).toHaveLength(1);
    expect(details.objects[0]['tm:name']).toBe('ZOLD');
  });
});
