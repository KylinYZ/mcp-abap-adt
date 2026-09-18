import { jest } from '@jest/globals';

/**
 * ============================================================================
 * readRfcTable 双路径适配测试（S/4 增强 ET_DATA vs 经典 DATA）
 * ============================================================================
 *
 * 真机实测（2026-09-18 专用 DEV，S/4HANA）：该系统的 RFC_READ_TABLE 被 SAP
 * 增强（USE_ET_DATA_4_RETURN + ET_DATA/SDTI_RESULT_TAB），经典 DATA 回填路径
 * 已死——不带开关时 DATA/FIELDS/ET_DATA 全空。本文件锁定适配层的系统差异
 * 处理契约：
 *   1. 接口含 USE_ET_DATA_4_RETURN → 载荷带开关 + 从 ET_DATA[].LINE 解析；
 *   2. 接口无该参数（旧系统）或适配器无元数据能力（Loopback）→ 经典路径，
 *      载荷不得带开关（open-rfc 请求侧对未知参数直接拒发）；
 *   3. 能力探测按适配器缓存（一次元数据往返），探测失败如实抛出且不缓存。
 */

import type { AdapterFunctionInterface, TransportAdapter } from '../rfc/transport.js';
import type { FmCallResult } from '../rfc/call.js';
import { readRfcTable } from '../rfc/read-table-adapter.js';

/** 测试桩：可注入接口元数据与预置响应，并记录载荷/探测调用。 */
function fakeAdapter(options: {
  readonly interfaceParams?: AdapterFunctionInterface['parameters']
  readonly result?: FmCallResult
  readonly interfaceError?: Error
}): TransportAdapter & {
  readonly payloads: Array<Record<string, unknown>>
  readonly interfaceLookups: string[]
} {
  const payloads: Array<Record<string, unknown>> = [];
  const interfaceLookups: string[] = [];
  const adapter: TransportAdapter = {
    async connect() {},
    async invoke(request) {
      payloads.push({ ...(request.payload ?? {}) });
      return options.result ?? {
        functionName: 'RFC_READ_TABLE', values: {}, tables: {}, exceptions: [], durationMs: 1
      };
    },
    async close() {},
    lastActivity: () => null,
    ...(options.interfaceParams !== undefined || options.interfaceError !== undefined
      ? {
          async getFunctionInterface(functionName: string) {
            interfaceLookups.push(functionName);
            if (options.interfaceError !== undefined) throw options.interfaceError;
            return { parameters: options.interfaceParams ?? [] };
          }
        }
      : {})
  };
  return Object.assign(adapter, { payloads, interfaceLookups });
}

/** 经典 RFC_READ_TABLE 接口（旧系统形态，无 USE_ET_DATA_4_RETURN）。 */
const CLASSIC_IFACE: AdapterFunctionInterface['parameters'] = [
  { parameterName: 'QUERY_TABLE', parameterClass: 'I' },
  { parameterName: 'DELIMITER', parameterClass: 'I' },
  { parameterName: 'ROWCOUNT', parameterClass: 'I' },
  { parameterName: 'DATA', parameterClass: 'T' },
  { parameterName: 'FIELDS', parameterClass: 'T' },
  { parameterName: 'OPTIONS', parameterClass: 'T' }
];

/** S/4 增强接口在经典形态之上追加的两个成员（真机实测 2026-09-18）。 */
const S4_ENHANCEMENT: AdapterFunctionInterface['parameters'] = [
  { parameterName: 'USE_ET_DATA_4_RETURN', parameterClass: 'I' },
  { parameterName: 'ET_DATA', parameterClass: 'E' }
];

describe('readRfcTable ET_DATA adaptation', () => {
  it('enhanced system: payload carries the flag and rows parse from ET_DATA LINE', async () => {
    const adapter = fakeAdapter({
      interfaceParams: [...CLASSIC_IFACE, ...S4_ENHANCEMENT],
      result: {
        functionName: 'RFC_READ_TABLE',
        values: {},
        tables: {
          ET_DATA: [{ LINE: '300|SAP SE' }, { LINE: '100|Test AG' }],
          FIELDS: [{ FIELDNAME: 'BUKRS' }, { FIELDNAME: 'BUTXT' }]
        },
        exceptions: [],
        durationMs: 2
      }
    });
    const result = await readRfcTable(adapter, { table: 'T001', fields: ['BUKRS', 'BUTXT'], maxRows: 10 });
    expect(adapter.payloads).toHaveLength(1);
    expect(adapter.payloads[0]['USE_ET_DATA_4_RETURN']).toBe('X');
    expect(adapter.payloads[0]['QUERY_TABLE']).toBe('T001');
    expect(adapter.payloads[0]['DELIMITER']).toBe('|');
    expect(result.rows).toEqual([['300', 'SAP SE'], ['100', 'Test AG']]);
    expect(result.fields).toEqual(['BUKRS', 'BUTXT']);
  });

  it('legacy system: payload never carries the flag and rows parse from DATA WA', async () => {
    const adapter = fakeAdapter({
      interfaceParams: CLASSIC_IFACE,
      result: {
        functionName: 'RFC_READ_TABLE',
        values: {},
        tables: {
          DATA: [{ WA: '300|SAP SE' }],
          FIELDS: [{ FIELDNAME: 'BUKRS' }, { FIELDNAME: 'BUTXT' }]
        },
        exceptions: [],
        durationMs: 2
      }
    });
    const result = await readRfcTable(adapter, { table: 'T001', fields: ['BUKRS', 'BUTXT'] });
    expect(adapter.payloads[0]).not.toHaveProperty('USE_ET_DATA_4_RETURN');
    expect(result.rows).toEqual([['300', 'SAP SE']]);
  });

  it('adapter without metadata capability falls back to the classic path', async () => {
    const adapter = fakeAdapter({
      result: {
        functionName: 'RFC_READ_TABLE',
        values: {},
        tables: { DATA: [{ WA: '100|X' }] },
        exceptions: [],
        durationMs: 1
      }
    });
    const result = await readRfcTable(adapter, { table: 'T001', maxRows: 1 });
    expect(adapter.interfaceLookups).toHaveLength(0);
    expect(adapter.payloads[0]).not.toHaveProperty('USE_ET_DATA_4_RETURN');
    expect(result.rows).toEqual([['100', 'X']]);
    expect(result.fields).toEqual([]);
  });

  it('capability probe is cached per adapter across repeated reads', async () => {
    const adapter = fakeAdapter({
      interfaceParams: [...CLASSIC_IFACE, ...S4_ENHANCEMENT],
      result: {
        functionName: 'RFC_READ_TABLE',
        values: {},
        tables: { ET_DATA: [{ LINE: '1' }] },
        exceptions: [],
        durationMs: 1
      }
    });
    await readRfcTable(adapter, { table: 'T001', maxRows: 1 });
    await readRfcTable(adapter, { table: 'T001', maxRows: 1 });
    expect(adapter.interfaceLookups).toEqual(['RFC_READ_TABLE']);
  });

  it('probe failure propagates as a rejection and is not cached', async () => {
    const adapter = fakeAdapter({
      interfaceParams: CLASSIC_IFACE,
      interfaceError: new Error('interface lookup transport failure')
    });
    await expect(readRfcTable(adapter, { table: 'T001', maxRows: 1 })).rejects.toThrow('interface lookup transport failure');
    await expect(readRfcTable(adapter, { table: 'T001', maxRows: 1 })).rejects.toThrow('interface lookup transport failure');
    // 失败不缓存：两次调用各自重新探测
    expect(adapter.interfaceLookups).toHaveLength(2);
  });
});
