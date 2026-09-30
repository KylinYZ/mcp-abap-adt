import { ADTClient } from '../adt/index';
import { session_types } from '../adt/AdtHTTP';
import { RuntimeGuardrails } from '../config/RuntimeGuardrails';
import { ToolExecutionGate } from '../lib/ToolExecutionGate';
import { createGateSelector } from '../lib/serverGuardrails';

const guardrails = RuntimeGuardrails.fromEnvironment({});
const errorResult = () => ({ content: [{ type: 'text', text: 'error' }], isError: true });

describe('tiered execution gate (read/write slots + read domain isolation)', () => {
  // 分级门夹具：写槽串行 1、读槽并发 2
  const writeGate = new ToolExecutionGate(1, 10);
  const readGate = new ToolExecutionGate(2, 10);
  const selector = createGateSelector(readGate, writeGate);

  it('routes read-only tools to the read gate and write tools to the write gate', () => {
    // read-only 类 → 读槽
    expect(selector('classComponents')).toBe(readGate);
    expect(selector('searchObject')).toBe(readGate);
    expect(selector('runQuery')).toBe(readGate);
    expect(selector('getObjectSource')).toBe(readGate);
    // 写类 → 写槽
    expect(selector('setObjectSource')).toBe(writeGate);
    expect(selector('lockObject')).toBe(writeGate);
    expect(selector('deleteObject')).toBe(writeGate);
    // 豁免清单 → 不过门
    expect(selector('healthcheck')).toBeUndefined();
    expect(selector('sap')).toBeUndefined();
    expect(selector('applyAbapChange')).toBeUndefined();
    expect(selector('getAbapChangeStatus')).toBeUndefined();
    // 分类缺失兜底 → 写槽（保守）
    expect(selector('__nonexistent_tool__')).toBe(writeGate);
  });

  it('routes controlled-chain read-only previews to the WRITE gate', () => {
    // 受控链只读前段绑定写域主客户端（常驻 stateful），必须挂写槽
    // 保证 stateful 会话永无并发，并与同链 apply 天然互斥
    expect(selector('previewAbapChange')).toBe(writeGate);
    expect(selector('previewAbapObjectCreation')).toBe(writeGate);
    expect(selector('previewObjectActivation')).toBe(writeGate);
    expect(selector('previewTransportCreation')).toBe(writeGate);
    expect(selector('previewTransportCleanup')).toBe(writeGate);
    expect(selector('previewCloneObject')).toBe(writeGate);
    expect(selector('previewControlledRename')).toBe(writeGate);
    expect(selector('previewMessageTextChange')).toBe(writeGate);
    expect(selector('previewDescriptionChange')).toBe(writeGate);
    expect(selector('previewDdicPropertyChange')).toBe(writeGate);
    expect(selector('previewPackageChange')).toBe(writeGate);
    expect(selector('previewRapOperation')).toBe(writeGate);
    expect(selector('previewDebugOperation')).toBe(writeGate);
    expect(selector('previewDebugVariableChange')).toBe(writeGate);
    expect(selector('previewQualityCheck')).toBe(writeGate);
  });

  it('lets read tools run while a write tool holds the write gate (cross-slot isolation)', async () => {
    const order: string[] = [];
    let releaseWrite!: () => void;
    const writeBlocker = new Promise<void>(resolve => { releaseWrite = resolve; });

    // 写工具占住写槽
    const writeOp = executeInGate(selector('setObjectSource')!, async () => {
      order.push('write-start');
      await writeBlocker;
      order.push('write-end');
    });
    await Promise.resolve();
    // 读工具进读槽，不被写槽阻塞（跨槽隔离——分级门的核心收益）
    const readOp = executeInGate(selector('searchObject')!, async () => {
      order.push('read-start');
      order.push('read-end');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['write-start', 'read-start', 'read-end']);

    releaseWrite();
    await Promise.all([writeOp, readOp]);
    expect(order).toEqual(['write-start', 'read-start', 'read-end', 'write-end']);
  });

  it('serializes two write tools in the write gate', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocker = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = executeInGate(selector('setObjectSource')!, async () => {
      order.push('w1-start');
      await firstBlocker;
      order.push('w1-end');
    });
    const second = executeInGate(selector('lockObject')!, async () => {
      order.push('w2-start');
      order.push('w2-end');
    });
    await Promise.resolve();
    await Promise.resolve();
    // 写槽串行：第二个写必须等第一个完成
    expect(order).toEqual(['w1-start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['w1-start', 'w1-end', 'w2-start', 'w2-end']);
  });

  it('rejects stateful sessions on the read-domain clone (structural isolation)', () => {
    // 读域（statelessClone）在类型层锁死 stateless：setter 抛错，
    // 保证读请求物理上到不了 stateful 会话
    const client = new ADTClient('https://dev.example.test', 'USER', 'PASSWORD', '300', 'EN');
    const clone = client.statelessClone;
    expect(() => { clone.stateful = session_types.stateful; })
      .toThrow(/Stateful sessions not allowed/);
    expect(clone.stateful).toBe(session_types.stateless);
  });
});

/** 在指定门上执行一个空操作（测试辅助）。 */
function executeInGate(gate: ToolExecutionGate | undefined, operation: () => Promise<void>): Promise<void> {
  const run = () => operation();
  return gate ? gate.run(run) : run();
}
