import net from 'node:net';
import crypto from 'node:crypto';
import { ApcWebSocketConnection, encodeTextFrame, expectedAcceptKey, parseFrame } from '../adt/ApcWebSocketBridge.js';
import { GitBridgeError, gitExport, gitGetTypes } from '../adt/GitBridgeApi.js';

/**
 * APC WebSocket 桥 + git 域 API 单测（离线：进程内假 RFC6455 服务端）。
 * 断言：握手校验（101/accept key/拒绝）、welcome 解析、请求相关联响应、
 * git 域成功/错误映射、参数校验、超时。
 */

/** 假 APC 服务端：握手 → welcome → 按注册的 handler 应答同 id 文本帧。 */
function fakeServer(handlers: {
  onMessage?: (msg: Record<string, unknown>, reply: (obj: Record<string, unknown>) => void) => void;
  rejectHandshake?: boolean;
}): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = net.createServer(socket => {
      let buf = Buffer.alloc(0);
      let handshaken = false;
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        // 握手请求
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1 && !handshaken) {
          handshaken = true;
          const head = buf.subarray(0, idx).toString('utf8');
          const key = (head.match(/Sec-WebSocket-Key: (\S+)/) || [])[1] || '';
          if (handlers.rejectHandshake) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.end();
            return;
          }
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            `Sec-WebSocket-Accept: ${expectedAcceptKey(key)}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
          );
          // welcome 推送（不 mask 的服务端帧）
          socket.write(encodeTextFrame(JSON.stringify({ id: 'welcome', success: true, data: { session: 'S1', version: '2.3.0', domains: ['git'] } })));
          buf = buf.subarray(idx + 4);
        }
        // 请求帧
        while (true) {
          const f = parseFrame(buf);
          if (!f) break;
          buf = f.rest;
          if (f.opcode === 0x1 && handlers.onMessage) {
            handlers.onMessage(JSON.parse(f.payload.toString('utf8')), (obj) => {
              socket.write(encodeTextFrame(JSON.stringify(obj)));
            });
          }
          if (f.opcode === 0x8) socket.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => new Promise(res => server.close(() => res()))
      });
    });
  });
}

function target(port: number) {
  return {
    host: '127.0.0.1',
    port,
    path: '/sap/bc/apc/sap/zadt_vsp?sap-client=200',
    authorization: 'Basic dXNlcjpwYXNz',
    timeoutMs: 5000
  };
}

describe('ApcWebSocketBridge handshake and framing', () => {
  it('handshakes, parses welcome, and correlates a request/response by id', async () => {
    const server = await fakeServer({
      onMessage: (msg, reply) => {
        if (msg.action === 'echo') reply({ id: msg.id, success: true, data: { echoed: msg.params } });
      }
    });
    const conn = await ApcWebSocketConnection.connect(target(server.port));
    expect((conn.welcome.data as Record<string, unknown>).version).toBe('2.3.0');
    expect(conn.welcome.data.domains).toEqual(['git']);
    const resp = await conn.request({ id: 'r1', action: 'echo', params: { a: 1 } });
    expect(resp).toEqual({ id: 'r1', success: true, data: { echoed: { a: 1 } } });
    conn.close();
    await server.close();
  });

  it('rejects a non-101 handshake with a clear error', async () => {
    const server = await fakeServer({ rejectHandshake: true });
    await expect(ApcWebSocketConnection.connect(target(server.port))).rejects.toThrow(/handshake refused/);
    await server.close();
  });

  it('times out when the server never answers the request id', async () => {
    const server = await fakeServer({ onMessage: () => { /* 不回 */ } });
    const conn = await ApcWebSocketConnection.connect(target(server.port));
    await expect(conn.request({ id: 'silent' }, 200)).rejects.toThrow(/timed out/);
    conn.close();
    await server.close();
  });
});

describe('git domain API over the bridge', () => {
  it('gitGetTypes maps the success payload', async () => {
    const server = await fakeServer({
      onMessage: (msg, reply) => {
        if (msg.action === 'get_types') reply({ id: msg.id, success: true, data: { count: 2, types: ['CLAS', 'PROG'] } });
      }
    });
    const result = await gitGetTypes(target(server.port));
    expect(result).toEqual({ count: 2, types: ['CLAS', 'PROG'] });
    await server.close();
  });

  it('gitGetTypes parses the real-server wire contract (data is a JSON string)', async () => {
    // 真机契约（2026-10-07，sap-dev）：zcl_vsp_git_service build_json_response
    // 把 data 序列化成 JSON 字符串——客户端首版当对象解析导致成功但全空
    const server = await fakeServer({
      onMessage: (msg, reply) => {
        if (msg.action === 'get_types') reply({ id: msg.id, success: true, data: JSON.stringify({ count: 2, skipped: 1, types: ['CLAS', 'PROG'] }) });
      }
    });
    const result = await gitGetTypes(target(server.port));
    expect(result).toEqual({ count: 2, skipped: 1, types: ['CLAS', 'PROG'] });
    await server.close();
  });

  it('gitExport maps the string-form data payload and reports malformed JSON as GIT_DATA_MALFORMED', async () => {
    const server = await fakeServer({
      onMessage: (msg, reply) => {
        if (msg.action === 'export') {
          reply({
            id: msg.id, success: true,
            data: JSON.stringify({
              objectCount: 3, fileCount: 5, zipBase64: 'UEsDBA==',
              errors: [{ path: 'INTF ZIF_X: boom', bytes: -1 }],
              files: [{ path: 'src/z001/z001.clas.abap', bytes: 100 }]
            })
          });
        }
      }
    });
    const result = await gitExport(target(server.port), { packages: ['Z001'] });
    expect(result.objectCount).toBe(3);
    expect(result.errors[0]).toEqual({ path: 'INTF ZIF_X: boom', bytes: -1 });
    expect(result.files[0]).toEqual({ path: 'src/z001/z001.clas.abap', bytes: 100 });
    await server.close();
  });

  it('gitExport sends packages/includeSubpackages and maps the zip payload', async () => {
    let seen: Record<string, unknown> = {};
    const server = await fakeServer({
      onMessage: (msg, reply) => {
        if (msg.action === 'export') {
          seen = msg as Record<string, unknown>;
          reply({
            id: msg.id, success: true,
            data: {
              objectCount: 3, fileCount: 5, zipBase64: 'UEsDBA==',
              files: [{ path: 'z001.clas.abap', bytes: 100 }]
            }
          });
        }
      }
    });
    const result = await gitExport(target(server.port), { packages: ['z001'], includeSubpackages: false });
    expect(seen.domain).toBe('git');
    expect((seen.params as any).packages).toEqual(['Z001']);
    expect((seen.params as any).includeSubpackages).toBe(false);
    expect(result).toEqual({
      objectCount: 3, fileCount: 5, zipBase64: 'UEsDBA==',
      errors: [],
      files: [{ path: 'z001.clas.abap', bytes: 100 }]
    });
    await server.close();
  });

  it('maps error responses to GitBridgeError with the server code', async () => {
    const server = await fakeServer({
      onMessage: (msg, reply) => {
        if (msg.action === 'get_types') {
          reply({ id: msg.id, success: false, error: { code: 'GIT_ERROR', message: 'INTF serializer boom' } });
        }
      }
    });
    await expect(gitGetTypes(target(server.port))).rejects.toThrow(GitBridgeError);
    await server.close();
  });

  it('validates the packages input before connecting', async () => {
    await expect(gitExport(target(1), { packages: [] })).rejects.toThrow(/non-empty array/);
    await expect(gitExport(target(1), { packages: ['   '] })).rejects.toThrow(/at least one valid/);
  });
});

describe('frame primitives', () => {
  it('expectedAcceptKey matches the RFC 6455 example vector', () => {
    expect(expectedAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('encodeTextFrame produces a masked text frame parseable back', () => {
    const frame = encodeTextFrame('{"a":1}');
    expect(frame[0] & 0x0f).toBe(1);
    expect((frame[1] & 0x80) !== 0).toBe(true); // masked
    const parsed = parseFrame(frame);
    expect(parsed?.opcode).toBe(1);
    expect(parsed?.payload.toString('utf8')).toBe('{"a":1}');
    expect(parsed?.rest.length).toBe(0);
  });
});
