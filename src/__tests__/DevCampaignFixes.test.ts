/**
 * sap-dev 全功能战役修复项回归测试：
 * - F1 classIncludes 处理器两步修复（类名→结构→includes 映射）
 * - F2 unitTestEvaluation 契约修复（类名→先跑测试→逐类评估；无测试返回空）
 * - F4 runWithOrderFallback 空 WHERE 时也回退无 ORDER BY（sap-dev 实测
 *   多列 ORDER BY 本身被 datapreview 拒绝）
 */
import { ClassHandlers } from '../handlers/ClassHandlers';
import { UnitTestHandlers } from '../handlers/UnitTestHandlers';
import { SafetyPolicy } from '../safe/SafetyPolicy';

describe('战役修复回归', () => {
  const policy = new SafetyPolicy({
    sapUrl: 'https://dev.example.com:44300', sapClient: '100', sapUser: 'DEVUSER',
    systemRole: 'DEV', allowedHosts: 'dev.example.com', allowedClients: '100',
    allowedNamespaces: 'Z', auditPath: 'C:\audit', toolProfile: 'development'
  });

  it('F1: classIncludes 先取结构再转映射（字符串不再直传静态方法）', async () => {
    const structure = {
      objectUrl: '/sap/bc/adt/oo/classes/zvcl_x',
      metaData: { 'adtcore:type': 'CLAS/OC', 'adtcore:name': 'ZVCL_X', 'class:visibility': 'public' },
      includes: [
        { 'class:includeType': 'main', links: [{ type: 'text/plain', href: './source/main' }] },
        { 'class:includeType': 'testclasses', links: [{ type: 'text/plain', href: './includes/testclasses' }] }
      ]
    };
    const client = {
      objectStructure: jest.fn().mockResolvedValue(structure)
    };
    const handlers = new ClassHandlers(client as never);
    const r = await handlers.handle('classIncludes', { clas: 'zvcl_x' });
    const parsed = JSON.parse((r.content || []).map((i: any) => i.text).join(''));
    expect(parsed.status).toBe('success');
    expect(client.objectStructure).toHaveBeenCalledWith('/sap/bc/adt/oo/classes/zvcl_x');
    const includes = parsed.result;
    expect(includes.main).toContain('/source/main');
    expect(includes.testclasses).toContain('/includes/testclasses');
  });

  it('F1b: 非类对象给可读错误（结构守卫）', async () => {
    const client = { objectStructure: jest.fn().mockResolvedValue({ objectUrl: '/x', metaData: { 'adtcore:type': 'PROG/P' } }) };
    const handlers = new ClassHandlers(client as never);
    await expect(handlers.handle('classIncludes', { clas: 'ZPROG_X' }))
      .rejects.toThrow(/not a class or exposes no class structure/);
  });

  it('F2: unitTestEvaluation 无测试类返回空数组与说明（不再 undefined.map 崩溃）', async () => {
    const client = {
      unitTestRun: jest.fn().mockResolvedValue([]),
      unitTestEvaluation: jest.fn()
    };
    const handlers = new UnitTestHandlers(client as never);
    const r = await handlers.handle('unitTestEvaluation', { clas: 'ZVCL_NO_TESTS' });
    const parsed = JSON.parse((r.content || []).map((i: any) => i.text).join(''));
    expect(parsed.status).toBe('success');
    expect(parsed.result).toEqual([]);
    expect(parsed.note).toMatch(/No unit tests found/);
    expect(client.unitTestEvaluation).not.toHaveBeenCalled();
  });

  it('F2b: unitTestEvaluation 有测试类时逐类评估汇总', async () => {
    const testClass = { 'adtcore:name': 'ZVCL_T1', testmethods: [{ 'adtcore:uri': '/sap/bc/adt/oo/classes/zvcl_t1/omethods/m1' }] };
    const client = {
      unitTestRun: jest.fn().mockResolvedValue([testClass]),
      unitTestEvaluation: jest.fn().mockResolvedValue([{ name: 'm1', result: 'pass' }])
    };
    const handlers = new UnitTestHandlers(client as never);
    const r = await handlers.handle('unitTestEvaluation', { clas: 'ZVCL_T1' });
    const parsed = JSON.parse((r.content || []).map((i: any) => i.text).join(''));
    expect(parsed.result).toEqual([{ name: 'm1', result: 'pass' }]);
    expect(client.unitTestEvaluation).toHaveBeenCalledWith(testClass, undefined);
  });
});
