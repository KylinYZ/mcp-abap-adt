import { jest } from '@jest/globals';

/**
 * ============================================================================
 * OpenRfcTransport 递归序列化器策略接线测试（rfc.remote-enabled.read-table）
 * ============================================================================
 *
 * 背景：open-rfc 对含 TABLES/深层参数的 FM 调用（如 RFC_READ_TABLE）在发送前
 * 要求显式的对端序列化器观测（LiveRecursiveSerializerPolicy），缺省直接拒发
 * （live-decision-required）。本测试锁定三件事：
 *   1. 缺省构造时 Client 收到 classic-xRFC 观测策略（决策门四个判定全过）；
 *   2. 构造 options 可覆盖策略与超时（为未来 basXML 目标留口）；
 *   3. invoke 输出归类（数组→tables、其余→values）不受接线影响。
 *
 * 策略能否真正过 open-rfc 的决策门由真机 smoke（scripts/read-table-real-dev-
 * smoke.mjs）闭环验证；mock 层只锁定接线契约。
 */

// mock 掉 open-rfc 的 Client：捕获构造参数，open/call/close 返回最小桩
const clientConstructs: Array<Record<string, unknown>> = [];
jest.mock('open-rfc', () => ({
  // languageIsoToSap 在构造器中未用到，但保留同签名以防后续接线
  languageIsoToSap: (value: string) => value,
  Client: jest.fn().mockImplementation(function (...args: unknown[]) {
    clientConstructs.push((args[1] as Record<string, unknown>) ?? {});
    return {
      open: async () => undefined,
      call: async () => ({ EV_TEXT: 'ok', TA: [{ A: '1' }] }),
      close: async () => undefined
    };
  })
}));

import { Client } from 'open-rfc';
import { OpenRfcTransport } from '../rfc/open-rfc-transport.js';
import { normalizeRfcConnectionParams } from '../rfc/connection.js';

/** 最小合法连接参数（normalizeRfcConnectionParams 会严格校验）。 */
const PARAMS = normalizeRfcConnectionParams({
  ashost: '10.30.254.48',
  client: '100',
  user: 'DEVUSER',
  password: 'secret',
  language: 'EN',
  sysnr: '01'
});

describe('OpenRfcTransport recursive serializer policy wiring', () => {
  beforeEach(() => {
    clientConstructs.length = 0;
    (Client as unknown as jest.Mock).mockClear();
  });

  it('default construction injects the classic-xRFC observation policy', async () => {
    const transport = new OpenRfcTransport(PARAMS);
    await transport.connect();
    // Client 构造参数：[connectionParameters, clientOptions]
    expect(Client).toHaveBeenCalledTimes(1);
    const clientOptions = clientConstructs[0];
    const policy = clientOptions['recursiveSerializerPolicy'] as Record<string, unknown>;
    // 决策门要求 live/classic-xrfc/sendAllowed/disabled——该观测经
    // open-rfc classifyRecursiveSerializer 恰好产出此判定
    expect(policy).toEqual({
      profile: 'abap-7.58',
      observation: {
        defaultSerializer: 'classic-xrfc',
        basxmlDisabledSerializer: 'classic-xrfc'
      }
    });
    // 未指定 timeout 时不应带 timeout 键（保持既有行为）
    expect(clientOptions).not.toHaveProperty('timeout');
  });

  it('constructor options override the policy and pass the timeout through', async () => {
    const override = {
      profile: 'abap-7.50' as const,
      observation: {
        defaultSerializer: 'classic-xrfc' as const,
        basxmlDisabledSerializer: 'unsupported' as const
      }
    };
    const transport = new OpenRfcTransport(PARAMS, {
      timeoutSeconds: 45,
      recursiveSerializerPolicy: override
    });
    await transport.connect();
    const clientOptions = clientConstructs[0];
    expect(clientOptions['recursiveSerializerPolicy']).toEqual(override);
    expect(clientOptions['timeout']).toBe(45);
  });

  it('invoke keeps mapping array outputs to tables after the policy wiring', async () => {
    const transport = new OpenRfcTransport(PARAMS);
    await transport.connect();
    const result = await transport.invoke({ functionName: 'RFC_TEST', payload: {} });
    // 数组值归 tables、标量归 values——策略接线不得改变 FmCallResult 语义
    expect(result.tables).toEqual({ TA: [{ A: '1' }] });
    expect(result.values).toEqual({ EV_TEXT: 'ok' });
    await transport.close();
  });
});
