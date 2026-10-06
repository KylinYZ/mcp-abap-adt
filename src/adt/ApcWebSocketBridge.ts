import net from 'node:net';
import crypto from 'node:crypto';

/**
 * ============================================================================
 * ZADT_VSP APC WebSocket 桥客户端（最小 RFC 6455 实现，基于 node:net）
 * ============================================================================
 *
 * 对接 ZCL_VSP_APC_HANDLER 的 JSON 消息协议（真机验证：sap-dev，2026-10-06）：
 *   - 握手：GET {path}?sap-client=<n> HTTP/1.1 + Upgrade: websocket +
 *     Sec-WebSocket-Key（RFC 6455 4.1），需 Basic Authorization 头——Node 全局
 *     WebSocket 构造器不支持自定义头，故直接走 TCP 套接字自实现。
 *   - 服务端连接后立即推送 welcome 帧：{"id":"welcome","success":true,
 *     "data":{"session":...,"version":...,"domains":[...]}}。
 *   - 请求：{"id":"<相关id>","domain":"...","action":"...","params":{...}}，
 *     响应携带同 id；无 id 的服务端推送（welcome 等）通过 onPush 上抛。
 *   - 帧：client→server 必须 mask（RFC 6455 5.3）；server→client 不 mask；
 *     处理 opcode 1(text)/0(continuation)/8(close)/9(ping→自动 pong)。
 *
 * 生命周期：每个调用会话独立（connect → request* → close），与本项目分级
 * 执行门解耦——桥走独立 TCP，不占用 ADT 的 stateful/stateless 会话。
 */

export interface ApcBridgeOptions {
  host: string
  port: number
  /** WebSocket 路径（含 sap-client 查询参数） */
  path: string
  /** Basic 认证值（"Basic base64(user:pass)"） */
  authorization: string
  /** 握手与单请求超时（毫秒） */
  timeoutMs?: number
}

export interface ApcBridgeWelcome {
  id: string
  success: boolean
  data: { session?: string; version?: string; domains?: string[] }
}

export type ApcBridgeFrameHandler = (payload: string) => void;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** RFC 6455 握手应答校验值：base64(sha1(key + GUID))。 */
export function expectedAcceptKey(clientKey: string): string {
  return crypto.createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

/** 客户端文本帧编码（必须 mask）。 */
export function encodeTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const mask = crypto.randomBytes(4);
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.from([0x81, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** 服务端帧解析状态机：从缓冲区提取完整帧（返回 null 表示不完整）。 */
export function parseFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let len = buffer[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(64 * 1024 * 1024)) throw new Error('websocket frame exceeds the 64 MiB guard');
    len = Number(big);
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buffer.length < offset + maskLen + len) return null;
  let payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, rest: buffer.subarray(offset + maskLen + len) };
}

/** 桥连接：一次握手 + JSON 请求相关联的响应读取。 */
export class ApcWebSocketConnection {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private pushHandler: ApcBridgeFrameHandler | null = null;
  private closedByServer = false;
  welcome!: ApcBridgeWelcome & { data: Record<string, unknown> }; // connect() 握手后填充

  // welcome 在 connect() 握手后填充（构造两段式）
  private constructor(welcome: ApcBridgeWelcome) {
    this.welcome = welcome;
  }

  /** 握手并等待 welcome 帧。 */
  static async connect(options: ApcBridgeOptions): Promise<ApcWebSocketConnection> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const clientKey = crypto.randomBytes(16).toString('base64');
    const socket = net.createConnection({ host: options.host, port: options.port });
    const conn = new (ApcWebSocketConnection as any)(null) as ApcWebSocketConnection;
    conn.socket = socket;

    const handshake = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('websocket handshake timed out')); }, timeoutMs);
      socket.once('error', (e) => { clearTimeout(timer); reject(e); });
      socket.once('connect', () => {
        socket.write(
          `GET ${options.path} HTTP/1.1\r\n` +
          `Host: ${options.host}:${options.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${clientKey}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Authorization: ${options.authorization}\r\n\r\n`
        );
      });
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        socket.off('data', onData);
        clearTimeout(timer);
        resolve(buf.subarray(0, idx).toString('utf8'));
        // 剩余字节（welcome 帧开头）交还帧解析器
        conn.buffer = Buffer.concat([conn.buffer, buf.subarray(idx + 4)]);
        socket.on('data', (d) => conn.onData(d));
        socket.on('close', () => conn.onClose());
        socket.on('error', () => conn.onClose());
      };
      socket.on('data', onData);
    });

    const statusLine = handshake.split('\r\n')[0];
    if (!statusLine.includes(' 101 ')) {
      socket.destroy();
      throw new Error(`websocket handshake refused: ${statusLine}`);
    }
    const acceptMatch = handshake.match(/sec-websocket-accept:\s*(\S+)/i);
    if (!acceptMatch || acceptMatch[1] !== expectedAcceptKey(clientKey)) {
      socket.destroy();
      throw new Error('websocket accept key mismatch');
    }

    // 等 welcome 帧（无 id 匹配需求，取首条推送）
    const welcomeRaw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('welcome frame timed out')), timeoutMs);
      conn.pushHandler = (payload) => { clearTimeout(timer); resolve(payload); };
      // welcome 可能已随握手响应同包到达（字节已在缓冲区）——立即排空
      conn.drain();
    });
    conn.welcome = JSON.parse(welcomeRaw) as ApcBridgeWelcome;
    return conn;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private onClose(): void {
    this.closedByServer = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('websocket closed by server while a request was pending'));
    }
    this.pending.clear();
    this.socket = null;
  }

  private drain(): void {
    while (true) {
      let frame;
      try {
        frame = parseFrame(this.buffer);
      } catch (e) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (!frame) return;
      this.buffer = frame.rest;
      if (frame.opcode === 0x9) { // ping → pong
        this.socket?.write(pongFrame(frame.payload));
        continue;
      }
      if (frame.opcode === 0x8) { this.onClose(); return; }
      if (frame.opcode === 0x1) {
        // 文本帧即完整消息（SAP APC 响应为单帧；续帧协议暂不涉及）
        this.deliver(frame.payload.toString('utf8'));
      }
    }
  }

  private deliver(payload: string): void {
    let id = '';
    try {
      const parsed = JSON.parse(payload);
      id = typeof parsed?.id === 'string' ? parsed.id : '';
    } catch (e) { id = ''; }
    const pendingEntry = id ? this.pending.get(id) : undefined;
    if (pendingEntry) {
      this.pending.delete(id);
      clearTimeout(pendingEntry.timer);
      pendingEntry.resolve(payload);
      return;
    }
    if (this.pending.size === 0 && !id) {
      this.pushHandler?.(payload);
      return;
    }
    // 不匹配的推送：作为 push 上抛（welcome 类）
    this.pushHandler?.(payload);
  }

  /** 发送 JSON 请求并等待同 id 响应（超时抛错）。 */
  async request(payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (!this.socket) throw new Error('websocket connection is closed');
    const id = String(payload.id ?? '');
    const timeout = timeoutMs ?? 60000;
    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`websocket request timed out after ${timeout} ms (id=${id})`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(encodeTextFrame(JSON.stringify(payload)));
    });
    return JSON.parse(result) as Record<string, unknown>;
  }

  /** 发送 close 帧并销毁套接字。 */
  close(): void {
    if (this.socket) {
      try { this.socket.write(Buffer.from([0x88, 0x00])); } catch (e) { }
      this.socket.destroy();
      this.socket = null;
    }
  }
}

function pongFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(2 + (payload.length > 125 ? 2 : 0));
  header[0] = 0x8a;
  if (payload.length <= 125) {
    header[1] = payload.length;
    return Buffer.concat([header, payload]);
  }
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}
