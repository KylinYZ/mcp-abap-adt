import { getCdsDependencies, getCdsImpactAnalysis, getCdsElementInfo, createCdsAnalysisClient } from '../adt/CdsDependencyApi.js';
import type { AdtHTTP } from '../adt/AdtHTTP.js';

/**
 * CdsDependencyApi 只读契约测试（mock HTTP 层，绝不连接真实 SAP）。
 * XML 样例模拟真实 ADT 响应（含命名空间前缀），断言三类内容：
 *   1. 请求契约：端点 URL、HTTP 方法、Accept/Content-Type 头、请求体；
 *   2. 解析结果：精简 JSON 的对象名/类型/URI/依赖方向与统计口径；
 *   3. 容错语义：空结果不抛错、结构异常返回空清单、HTTP 错误原样传播。
 */

/** 构造仅含 request mock 的 AdtHTTP 假会话（对齐 Controlled*Adt 测试写法）。 */
function http(body: string): AdtHTTP {
  return { request: jest.fn().mockResolvedValue({ body, status: 200, headers: {} }) } as unknown as AdtHTTP;
}

// CDS 依赖树（doubledata 端点）的真实感响应：上游 2 张表 + 1 个 CDS 视图
const DOUBLE_DATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testcodegen:doubledata xmlns:testcodegen="http://www.sap.com/adt/testcodegen">
  <testcodegen:cdsundertest testcodegen:cds_name="ZC_TRAVEL_U">
    <testcodegen:doublelist>
      <testcodegen:double testcodegen:double_name="/DMO/I_TRAVEL" testcodegen:double_type="TABLE"/>
      <testcodegen:double testcodegen:double_name="ZC_BOOKING_U" testcodegen:double_type="CDS_VIEW"/>
      <testcodegen:double testcodegen:double_name="/DMO/I_CUSTOMER" testcodegen:double_type="TABLE"/>
    </testcodegen:doublelist>
  </testcodegen:cdsundertest>
</testcodegen:doubledata>`;

// CDS 反向影响（usageReferences 端点）的真实感响应：1 个命中 + 1 个导航上下文
const USAGE_REFERENCES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<usageReferences:usageReferenceResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences" xmlns:adtcore="http://www.sap.com/adt/core">
  <usageReferences:referencedObjects>
    <usageReferences:referencedObject usageReferences:uri="adtref://hit" usageReferences:isResult="true">
      <usageReferences:adtObject adtcore:uri="/sap/bc/adt/ddic/ddl/sources/zc_consumer" adtcore:type="DDLS/DDLS" adtcore:name="ZC_CONSUMER" adtcore:description="消费视图">
        <adtcore:packageRef adtcore:name="Z001"/>
      </usageReferences:adtObject>
    </usageReferences:referencedObject>
    <usageReferences:referencedObject usageReferences:uri="adtref://context" usageReferences:isResult="false">
      <usageReferences:adtObject adtcore:uri="/sap/bc/adt/oo/classes/zcl_nav" adtcore:type="CLAS/OC" adtcore:name="ZCL_NAV"/>
    </usageReferences:referencedObject>
  </usageReferences:referencedObjects>
</usageReferences:usageReferenceResult>`;

// CDS 元素元数据（ddlsources.v2 端点）的真实感响应：2 个元素 + 1 条注解
const DDL_SOURCE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ddl:ddlSource xmlns:ddl="http://www.sap.com/adt/ddic/ddl" xmlns:adtcore="http://www.sap.com/adt/core" ddl:name="ZC_TRAVEL_U">
  <ddl:content>
    <ddl:element ddl:name="TravelUUID" ddl:type="sysuuid.xsd:string16" ddl:semantics="key">
      <ddl:annotation ddl:name="EndUserText.label" ddl:value="Travel"/>
    </ddl:element>
    <ddl:element ddl:name="TravelID" ddl:type="abap.numc(8)" ddl:description="Travel ID"/>
  </ddl:content>
</ddl:ddlSource>`;

describe('CdsDependencyApi getCdsDependencies (read-only upstream tree)', () => {
  it('requests the testcodegen doubledata endpoint and parses a trimmed upstream tree', async () => {
    const client = http(DOUBLE_DATA_XML);
    const result = await getCdsDependencies(client, { objectName: 'zc_travel_u' });

    // 请求契约：端点与 Accept 头逐字对齐 VSP pkg/adt/cds.go
    expect(client.request).toHaveBeenCalledWith(
      '/sap/bc/adt/testcodegen/dependencies/doubledata?ddlsourceName=ZC_TRAVEL_U',
      { method: 'GET', headers: { Accept: 'application/vnd.sap.adt.codegen.data.v1+xml' } }
    );
    // 小写输入被规范化为大写后再拼 URL

    // 精简 JSON：方向、根节点、展平依赖（relation 一律 FROM）
    expect(result).toEqual({
      objectName: 'ZC_TRAVEL_U',
      direction: 'upstream',
      root: { name: 'ZC_TRAVEL_U', type: 'CDS_VIEW' },
      dependencies: [
        { name: '/DMO/I_TRAVEL', type: 'TABLE', relation: 'FROM' },
        { name: 'ZC_BOOKING_U', type: 'CDS_VIEW', relation: 'FROM' },
        { name: '/DMO/I_CUSTOMER', type: 'TABLE', relation: 'FROM' }
      ],
      statistics: { total: 3, tableCount: 2, depth: 2, byType: { TABLE: 2, CDS_VIEW: 1 } }
    });
  });

  it('returns an empty tree when the endpoint reports no dependencies', async () => {
    const client = http(`<?xml version="1.0"?>
<cdsundertest cds_name="ZC_EMPTY"><doublelist/></cdsundertest>`);
    const result = await getCdsDependencies(client, { objectName: 'ZC_EMPTY' });

    expect(result.dependencies).toEqual([]);
    expect(result.statistics).toEqual({ total: 0, tableCount: 0, depth: 1, byType: {} });
  });

  it('returns an empty tree when the payload structure is unexpected', async () => {
    const client = http('<unexpected/>');
    const result = await getCdsDependencies(client, { objectName: 'ZC_ODD' });

    expect(result.root).toEqual({ name: 'ZC_ODD', type: 'CDS_VIEW' });
    expect(result.dependencies).toEqual([]);
  });

  it('propagates upstream HTTP errors unchanged', async () => {
    const failure = new Error('HTTP 404');
    const client = { request: jest.fn().mockRejectedValue(failure) } as unknown as AdtHTTP;
    await expect(getCdsDependencies(client, { objectName: 'ZC_MISSING' })).rejects.toBe(failure);
  });

  it('rejects invalid object names before any HTTP call', async () => {
    const client = http('');
    await expect(getCdsDependencies(client, { objectName: '' })).rejects.toThrow(/objectName/);
    await expect(getCdsDependencies(client, { objectName: 'A B' })).rejects.toThrow(/objectName/);
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe('CdsDependencyApi getCdsImpactAnalysis (read-only downstream impact)', () => {
  it('posts the usageReferences query with a server-derived CDS URI and keeps hits only', async () => {
    const client = http(USAGE_REFERENCES_XML);
    const result = await getCdsImpactAnalysis(client, { objectName: 'zc_travel_u' });

    // 请求契约：对象 URI 由服务端从对象名推导（%2F 转义），方法/头/体对齐 VSP cds_tools.go
    const [url, config] = (client.request as jest.Mock).mock.calls[0];
    expect(url).toBe(
      `/sap/bc/adt/repository/informationsystem/usageReferences?uri=${encodeURIComponent('/sap/bc/adt/ddic/ddl/sources/ZC_TRAVEL_U')}`
    );
    expect(config.method).toBe('POST');
    expect(config.headers).toEqual({ 'Content-Type': 'application/*', Accept: 'application/*' });
    expect(config.body).toContain('usageReferenceRequest');
    expect(config.body).toContain('http://www.sap.com/adt/ris/usageReferences');

    // isResult=false 的导航上下文必须被过滤，只保留命中对象
    expect(result).toEqual({
      objectName: 'ZC_TRAVEL_U',
      direction: 'downstream',
      impactedObjects: [{
        name: 'ZC_CONSUMER',
        type: 'DDLS/DDLS',
        uri: '/sap/bc/adt/ddic/ddl/sources/zc_consumer',
        description: '消费视图',
        packageRef: 'Z001'
      }],
      totalCount: 1
    });
  });

  it('returns an empty impact list when no object references the CDS view', async () => {
    const client = http(`<?xml version="1.0"?>
<usageReferenceResult><referencedObjects/></usageReferenceResult>`);
    const result = await getCdsImpactAnalysis(client, { objectName: 'ZC_ISOLATED' });

    expect(result.impactedObjects).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('returns an empty impact list instead of failing on malformed XML', async () => {
    const client = http('this is not xml');
    const result = await getCdsImpactAnalysis(client, { objectName: 'ZC_ODD' });

    expect(result.impactedObjects).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('propagates upstream HTTP errors unchanged', async () => {
    const failure = new Error('HTTP 500');
    const client = { request: jest.fn().mockRejectedValue(failure) } as unknown as AdtHTTP;
    await expect(getCdsImpactAnalysis(client, { objectName: 'ZC_X' })).rejects.toBe(failure);
  });
});

describe('CdsDependencyApi getCdsElementInfo (read-only element metadata)', () => {
  it('reads ddlsources.v2 metadata and parses elements with annotations', async () => {
    const client = http(DDL_SOURCE_XML);
    const result = await getCdsElementInfo(client, { objectName: 'zc_travel_u' });

    // 请求契约：DDL 源结构化读取端点与 v2 Accept 头
    expect(client.request).toHaveBeenCalledWith('/sap/bc/adt/ddic/ddl/sources/ZC_TRAVEL_U', {
      method: 'GET',
      headers: { Accept: 'application/vnd.sap.adt.ddic.ddlsources.v2+xml' }
    });

    // 元素裁剪：仅 name/type/description/semantics/annotations；无注解元素不带 annotations 字段
    expect(result).toEqual({
      objectName: 'ZC_TRAVEL_U',
      viewName: 'ZC_TRAVEL_U',
      elements: [
        {
          name: 'TravelUUID',
          type: 'sysuuid.xsd:string16',
          semantics: 'key',
          annotations: { 'EndUserText.label': 'Travel' }
        },
        { name: 'TravelID', type: 'abap.numc(8)', description: 'Travel ID' }
      ]
    });
  });

  it('falls back to the flat field structure of older ADT versions', async () => {
    const client = http(`<?xml version="1.0"?>
<ddlSource xmlns="http://www.sap.com/adt/ddic/ddl" name="ZC_LEGACY">
  <field name="LegacyKey" type="raw(16)"/>
</ddlSource>`);
    const result = await getCdsElementInfo(client, { objectName: 'ZC_LEGACY' });

    expect(result.viewName).toBe('ZC_LEGACY');
    expect(result.elements).toEqual([{ name: 'LegacyKey', type: 'raw(16)' }]);
  });

  it('returns an empty element list when the response carries no elements', async () => {
    const client = http('<ddlSource name="ZC_NONE"/>');
    const result = await getCdsElementInfo(client, { objectName: 'ZC_NONE' });

    expect(result.elements).toEqual([]);
  });

  it('falls back to the legacy ddlSource representation when v2 is not acceptable', async () => {
    // 真机 DEV 场景：系统未注册 ddlsources.v2 类型（406 语义），v2 请求失败后
    // 应回退老 Accept 类型重试；老表示无元素清单，结果应为空 + note 降级说明。
    const request = jest
      .fn()
      .mockRejectedValueOnce(new Error('The message content is not acceptable. Accepted content types: application/vnd.sap.adt.ddlSource+xml'))
      .mockResolvedValueOnce({ body: '<ddlSource name="ZC_OLD"/>', status: 200, headers: {} });
    const client = { request } as unknown as AdtHTTP;
    const result = await getCdsElementInfo(client, { objectName: 'ZC_OLD' });

    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0][1].headers.Accept)).toContain('ddlsources.v2');
    expect(String(request.mock.calls[1][1].headers.Accept)).toContain('adt.ddlSource+xml');
    expect(result.elements).toEqual([]);
    expect(result.note).toMatch(/v2/);
  });

  it('propagates upstream HTTP errors unchanged', async () => {
    const failure = new Error('HTTP 403');
    const client = { request: jest.fn().mockRejectedValue(failure) } as unknown as AdtHTTP;
    await expect(getCdsElementInfo(client, { objectName: 'ZC_X' })).rejects.toBe(failure);
  });
});

describe('CdsAnalysisClient binding', () => {
  it('binds the three read-only capabilities to one AdtHTTP session', async () => {
    const client = http(DDL_SOURCE_XML);
    const bound = createCdsAnalysisClient(client);

    await bound.getCdsDependencies({ objectName: 'ZC_A' });
    await bound.getCdsImpactAnalysis({ objectName: 'ZC_A' });
    await bound.getCdsElementInfo({ objectName: 'ZC_A' });

    // 三次调用必须全部落在同一个注入会话上，且都是读请求
    const calls = (client.request as jest.Mock).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(call => call[1].method)).toEqual(['GET', 'POST', 'GET']);
  });
});
