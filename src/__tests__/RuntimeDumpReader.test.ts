import { RuntimeDumpReader, buildRuntimeDumpQuery } from '../read/RuntimeDumpReader';
import type { Dump, DumpsFeed } from '../adt/index.js';

const baseInput = {
  from: '2026-08-16T00:00:00+08:00',
  to: '2026-08-16T23:59:59+08:00'
};

function feed(dumps: Dump[]): DumpsFeed {
  return {
    href: '/sap/bc/adt/runtime/dumps',
    title: 'Runtime Errors',
    updated: new Date('2026-08-17T00:00:00Z'),
    dumps
  };
}

function dump(index: number): Dump {
  return {
    id: `dump-${index}`,
    author: 'DEV_USER',
    categories: [{ term: 'MESSAGE_TYPE_X', label: 'ABAP runtime error' }],
    links: [{ href: `/dump-${index}`, rel: 'self', type: 'application/atom+xml' }],
    text: `Runtime error ${index}`,
    type: 'text',
    published: new Date('2026-08-16T08:00:00Z'),
    updated: new Date('2026-08-16T08:05:00Z')
  };
}

describe('RuntimeDumpReader', () => {
  it('builds only the time-window feed predicate (filters are client-side; the feed rejects search predicates)', () => {
    // 缺陷修复（2026-09-18）：该 ADT feed 只支持 between datetime，其余谓词
    // 真机 InternalError——user/objectName/runtimeError/exception 一律客户端过滤
    expect(buildRuntimeDumpQuery({
      ...baseInput,
      user: 'DEV_USER',
      objectName: 'Z_ORDER',
      runtimeError: 'MESSAGE_TYPE_X',
      exception: 'CX_ROOT'
    })).toBe('and ( between ( datetime , 20260816000000 , 20260816235959 ) )');
  });

  it('applies user/objectName/runtimeError/exception filters on the client', async () => {
    const client = {
      dumps: jest.fn().mockResolvedValue(feed([
        dump(0),                                                        // 匹配全部默认断言
        { ...dump(1), author: 'OTHER_USER' },                           // user 不匹配
        { ...dump(2), categories: [{ term: 'CX_ROOT', label: 'ABAP runtime error' }] }, // runtimeError 不匹配
        { ...dump(3), categories: [
          { term: 'MESSAGE_TYPE_X', label: 'ABAP runtime error' },
          { term: 'Z_ORDER', label: 'Terminated ABAP program' }
        ] }                                                             // 匹配（objectName contains）
      ]))
    };
    const reader = new RuntimeDumpReader(client as never);
    const result = await reader.read({ ...baseInput, user: 'DEV_USER', objectName: 'Z_ORDER', runtimeError: 'MESSAGE_TYPE_X' });

    // 服务端查询只含时间窗；客户端过滤后仅保留匹配条目
    //（dump-0 无程序类别，objectName contains 过滤下正确地不匹配）
    expect(client.dumps).toHaveBeenCalledWith('and ( between ( datetime , 20260816000000 , 20260816235959 ) )');
    expect(result.dumps.map(d => d.id)).toEqual(['dump-3']);
  });

  it('rejects invalid windows and mismatched offsets before SAP access', async () => {
    const client = { dumps: jest.fn() };
    const reader = new RuntimeDumpReader(client as never);

    await expect(reader.read({ ...baseInput, to: '2026-08-24T00:00:01+08:00' })).rejects.toThrow('seven days');
    await expect(reader.read({ ...baseInput, to: '2026-08-16T23:59:59Z' })).rejects.toThrow('same time-zone offset');
    expect(client.dumps).not.toHaveBeenCalled();
  });

  it('treats injection-shaped filter values as harmless client-side text (no SQL surface)', async () => {
    // 修复后过滤值不再进入服务端查询：注入形态只是匹配不到任何条目的普通文本
    const client = { dumps: jest.fn().mockResolvedValue(feed([dump(0)])) };
    const reader = new RuntimeDumpReader(client as never);
    const result = await reader.read({ ...baseInput, objectName: 'Z_ORDER ) or ( equals ( user , ADMIN' });
    expect(client.dumps).toHaveBeenCalledTimes(1);
    expect(result.dumps).toEqual([]);
  });

  it('returns a bounded summary and explicit truncation metadata', async () => {
    const client = { dumps: jest.fn().mockResolvedValue(feed(Array.from({ length: 25 }, (_, index) => dump(index)))) };
    const reader = new RuntimeDumpReader(client as never);

    const result = await reader.read(baseInput);

    expect(client.dumps).toHaveBeenCalledWith('and ( between ( datetime , 20260816000000 , 20260816235959 ) )');
    expect(result).toMatchObject({ returnedCount: 20, feedCount: 25, truncated: true });
    expect(result.dumps).toHaveLength(20);
    expect(result.dumps[0]).toEqual({
      id: 'dump-0',
      author: 'DEV_USER',
      categories: [{ term: 'MESSAGE_TYPE_X', label: 'ABAP runtime error' }],
      text: 'Runtime error 0',
      type: 'text',
      published: new Date('2026-08-16T08:00:00Z'),
      updated: new Date('2026-08-16T08:05:00Z')
    });
  });

  it('enforces a limit between one and fifty', async () => {
    const client = { dumps: jest.fn() };
    const reader = new RuntimeDumpReader(client as never);

    await expect(reader.read({ ...baseInput, limit: 0 })).rejects.toThrow('limit');
    await expect(reader.read({ ...baseInput, limit: 51 })).rejects.toThrow('limit');
    expect(client.dumps).not.toHaveBeenCalled();
  });
});
