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
  it('builds only supported structured feed predicates', () => {
    expect(buildRuntimeDumpQuery({
      ...baseInput,
      user: 'DEV_USER',
      objectName: 'Z_ORDER',
      runtimeError: 'MESSAGE_TYPE_X',
      exception: 'CX_ROOT'
    })).toBe([
      'and ( between ( datetime , 20260816000000 , 20260816235959 ) )',
      'and ( equals ( user , DEV_USER ) )',
      'and ( contains ( objectName , Z_ORDER ) )',
      'and ( contains ( runtimeError , MESSAGE_TYPE_X ) )',
      'and ( contains ( exception , CX_ROOT ) )'
    ].join(' '));
  });

  it('rejects invalid windows, injected predicates, and mismatched offsets before SAP access', async () => {
    const client = { dumps: jest.fn() };
    const reader = new RuntimeDumpReader(client as never);

    await expect(reader.read({ ...baseInput, to: '2026-08-24T00:00:01+08:00' })).rejects.toThrow('seven days');
    await expect(reader.read({ ...baseInput, objectName: 'Z_ORDER ) or ( equals ( user , ADMIN' })).rejects.toThrow('objectName');
    await expect(reader.read({ ...baseInput, to: '2026-08-16T23:59:59Z' })).rejects.toThrow('same time-zone offset');
    expect(client.dumps).not.toHaveBeenCalled();
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
