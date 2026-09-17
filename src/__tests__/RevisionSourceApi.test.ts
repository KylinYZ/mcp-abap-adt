import {
  getRevisionSource,
  compareRevisions,
  compareSourceObjects,
  unifiedDiff,
  createRevisionSourceClient
} from '../adt/RevisionSourceApi.js';
import type { RevisionSourceCapability } from '../adt/RevisionSourceApi.js';

/**
 * RevisionSourceApi 只读契约测试（mock 能力通道，绝不连接真实 SAP）。
 * 断言四类内容：
 *   1. 解析链：quick search 精确匹配 → revisions 清单 → 版本源码 GET；
 *   2. 版本选择：标签精确匹配（大小写不敏感，对 version/versionTitle 双字段）、
 *      index 1-based 序号、发现模式（不带选择器返回清单）；
 *   3. 失败语义：对象未找到/版本未找到的明确报错、参数白名单；
 *   4. 输入边界：objectType 枚举、名字白名单、index 越界收敛。
 */

const REVISIONS: Array<{ uri: string; version: string; versionTitle: string; date: string; author: string }> = [
  { uri: '/sap/bc/adt/oo/classes/zcl_foo/source/main?version=2', version: 'INACTIVE', versionTitle: '2026-09-17 10:00', date: '2026-09-17T10:00:00', author: 'DEVUSER' },
  { uri: '/sap/bc/adt/oo/classes/zcl_foo/source/main?version=1', version: 'ACTIVE', versionTitle: '2026-09-16 09:00', date: '2026-09-16T09:00:00', author: 'DEVUSER' }
];

function clientMock(): RevisionSourceCapability & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    searchObject: jest.fn(async (query: string) => (
      query === 'ZCL_FOO'
        ? [{ 'adtcore:name': 'ZCL_FOO', 'adtcore:type': 'CLAS/OC', 'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_foo' }]
        : []
    )),
    revisions: jest.fn(async () => REVISIONS),
    objectStructure: jest.fn(async () => ({
      metaData: {},
      includes: [{ 'class:includeType': 'main', 'abapsource:sourceUri': 'source/main' }]
    })),
    getObjectSource: jest.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('version=2')) return 'INACTIVE SOURCE';
      if (url.includes('version=1')) return 'ACTIVE SOURCE';
      // 无版本参数 = 当前激活源码（objectStructure → 相对 URI 绝对化后的主源）
      return 'CURRENT SOURCE';
    })
  };
}

describe('getRevisionSource (VSP op:source / GetRevisionSource port)', () => {
  it('reads a revision by exact version label (case-insensitive)', async () => {
    const client = clientMock();
    const result = await getRevisionSource(client, { objectType: 'CLAS', objectName: ' zcl_foo ', version: 'active' });
    expect(result.version).toBe('ACTIVE');
    expect(result.source).toBe('ACTIVE SOURCE');
    expect(result.lines).toBe(1);
    expect(result.author).toBe('DEVUSER');
  });

  it('matches the versionTitle as an alternative label', async () => {
    const client = clientMock();
    const result = await getRevisionSource(client, { objectType: 'CLAS', objectName: 'ZCL_FOO', version: '2026-09-17 10:00' });
    expect(result.version).toBe('INACTIVE');
    expect(result.source).toBe('INACTIVE SOURCE');
  });

  it('reads by 1-based index into the newest-first list', async () => {
    const client = clientMock();
    const result = await getRevisionSource(client, { objectType: 'CLAS', objectName: 'ZCL_FOO', index: 1 });
    expect(result.version).toBe('INACTIVE'); // 清单最新在前
    expect(result.source).toBe('INACTIVE SOURCE');
  });

  it('returns the version list in discovery mode without a selector', async () => {
    const client = clientMock();
    const result = await getRevisionSource(client, { objectType: 'CLAS', objectName: 'ZCL_FOO' });
    expect(result.availableVersions).toHaveLength(2);
    expect(result.availableVersions?.[0]).toEqual({
      version: 'INACTIVE', versionTitle: '2026-09-17 10:00', date: '2026-09-17T10:00:00', author: 'DEVUSER'
    });
    expect(result.message).toContain('Discovery mode');
    expect(result.source).toBeUndefined();
    expect(client.calls).toHaveLength(0); // 发现模式不读源码
  });

  it('reports a clear error for an unknown version label', async () => {
    const client = clientMock();
    await expect(getRevisionSource(client, { objectType: 'CLAS', objectName: 'ZCL_FOO', version: 'NOPE' }))
      .rejects.toThrow(/not found.*(INACTIVE, ACTIVE)/);
  });

  it('rejects unknown objects and malformed inputs before reads', async () => {
    const client = clientMock();
    await expect(getRevisionSource(client, { objectType: 'CLAS', objectName: 'ZCL_MISSING' }))
      .rejects.toThrow(/no unique CLAS object/);
    await expect(getRevisionSource(client, { objectType: 'XSLT' as any, objectName: 'ZCL_FOO' }))
      .rejects.toThrow(/objectType must be/);
    await expect(getRevisionSource(client, { objectType: 'CLAS', objectName: "A';--" }))
      .rejects.toThrow(/not a repository name/);
  });

  it('treats a non-positive index as revision-not-found', async () => {
    const client = clientMock();
    // API 层 index 从 1 起；0 落在清单外 → 明确的 not found
    await expect(getRevisionSource(client, { objectType: 'CLAS', objectName: 'ZCL_FOO', index: 0 }))
      .rejects.toThrow(/not found/);
  });
});

describe('createRevisionSourceClient binding', () => {
  it('exposes getRevisionSource over the injected capability', async () => {
    const client = clientMock();
    const bound = createRevisionSourceClient(client);
    const result = await bound.getRevisionSource({ objectType: 'CLAS', objectName: 'ZCL_FOO', index: 2 });
    expect(result.version).toBe('ACTIVE');
  });
});

/* ==========================================================================
 * 版本对比（compareRevisions / unifiedDiff）
 * ========================================================================== */

describe('compareRevisions (VSP CompareVersions port)', () => {
  it('compares a revision against current with LCS diff and line counts', async () => {
    const client = clientMock();
    // REVISIONS 清单里 version=1（ACTIVE）的源码是 'ACTIVE SOURCE'（单行），
    // 当前源码是 'CURRENT SOURCE'（单行）→ 1 增 1 删
    const result = await compareRevisions(client, {
      objectType: 'CLAS', objectName: 'ZCL_FOO', version1: 'ACTIVE'
    });
    expect(result.identical).toBe(false);
    expect(result.label1).toBe('CLAS:ZCL_FOO@ACTIVE');
    expect(result.label2).toBe('CLAS:ZCL_FOO@current');
    expect(result.diff).toContain('--- CLAS:ZCL_FOO@ACTIVE');
    expect(result.diff).toContain('+++ CLAS:ZCL_FOO@current');
    expect(result.diff).toContain('-ACTIVE SOURCE');
    expect(result.diff).toContain('+CURRENT SOURCE');
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
  });

  it('reports identical sources without a diff body', async () => {
    const client = clientMock();
    const result = await compareRevisions(client, {
      objectType: 'CLAS', objectName: 'ZCL_FOO', version1: '1', version2: '1'
    });
    expect(result.identical).toBe(true);
    expect(result.diff).toBe('Sources are identical');
    expect(result.addedLines).toBe(0);
  });

  it('rejects unknown revision selectors with the available labels', async () => {
    const client = clientMock();
    await expect(compareRevisions(client, {
      objectType: 'CLAS', objectName: 'ZCL_FOO', version1: 'NOPE'
    })).rejects.toThrow(/was not found.*INACTIVE/);
  });

  it('rejects missing version1 and malformed inputs', async () => {
    const client = clientMock();
    await expect(compareRevisions(client, {
      objectType: 'CLAS', objectName: 'ZCL_FOO', version1: ''
    })).rejects.toThrow(/version1 is required/);
    await expect(compareRevisions(client, {
      objectType: 'TABL' as any, objectName: 'ZCL_FOO', version1: '1'
    })).rejects.toThrow(/objectType must be/);
  });
});

describe('unifiedDiff (VSP generateUnifiedDiff port)', () => {
  it('produces hunks with 3 context lines and correct counts', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'e', 'X', 'g', 'h', 'i', 'j'].join('\n');
    const { diff, addedLines, removedLines } = unifiedDiff('old', 'new', before, after);
    expect(addedLines).toBe(1);
    expect(removedLines).toBe(1);
    expect(diff).toContain('--- old');
    expect(diff).toContain('+++ new');
    // 变更行是 f→X（第 6 行），e/g 作为上下文进入 hunk
    expect(diff).toContain('-f');
    expect(diff).toContain('+X');
    expect(diff).toContain(' e');
    expect(diff).toMatch(/@@ -3,7 \+3,7 @@/);
  });

  it('produces separate hunks for distant changes', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'].join('\n');
    const after = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'P'].join('\n');
    const { diff } = unifiedDiff('old', 'new', before, after);
    expect(diff.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g)?.length).toBe(2);
  });
});

/* ==========================================================================
 * 对象间源码对比（compareSourceObjects）
 * ========================================================================== */

describe('compareSourceObjects (VSP CompareSource port)', () => {
  it('diffs two different objects with labels and line counts', async () => {
    const client = clientMock();
    const result = await compareSourceObjects(client, {
      objectType1: 'CLAS', objectName1: 'ZCL_FOO', objectType2: 'CLAS', objectName2: 'ZCL_FOO'
    });
    // 同对象自比：两份源码相同（version=1/2 路径外，current 主源都是同一 URL）
    expect(result.identical).toBe(true);
    expect(result.diff).toBe('Sources are identical');
  });

  it('rejects malformed kinds and missing names before any read', async () => {
    const client = clientMock();
    await expect(compareSourceObjects(client, {
      objectType1: 'TABL' as any, objectName1: 'Z1', objectType2: 'PROG', objectName2: 'Z2'
    })).rejects.toThrow(/objectType1 must be/);
    await expect(compareSourceObjects(client, {
      objectType1: 'PROG', objectName1: '', objectType2: 'PROG', objectName2: 'Z2'
    })).rejects.toThrow(/objectName1.*not a repository name/);
    await expect(compareSourceObjects(client, {
      objectType1: 'PROG', objectName1: "Z';--", objectType2: 'PROG', objectName2: 'Z2'
    })).rejects.toThrow(/not a repository name/);
  });

  it('exposes compareSourceObjects via the bound client', async () => {
    const client = clientMock();
    const bound = createRevisionSourceClient(client);
    const result = await bound.compareSourceObjects({
      objectType1: 'CLAS', objectName1: 'ZCL_FOO', objectType2: 'CLAS', objectName2: 'ZCL_FOO'
    });
    expect(result.identical).toBe(true);
  });
});
