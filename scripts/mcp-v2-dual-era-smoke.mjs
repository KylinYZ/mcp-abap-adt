/**
 * 双协议 era 冒烟（0.9.0 v2 迁移资产）：
 *   1) 裸 stdio 探测帧：模拟 ZCode auto 协商（server/discover + 2026-07-28
 *      envelope），断言毫秒级明确应答（不再依赖超时回落）；
 *   2) v2 client modern 会话：discover 协商 → tools/list（断言 2026 wire
 *      特征 ttlMs/cacheScope）→ callTool healthcheck；
 *   3) v1 SDK client legacy 会话（2025 宿主代表）：initialize 握手 →
 *      tools/list → callTool healthcheck，锁定向后兼容面。
 * 用法：node scripts/mcp-v2-dual-era-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as StdioClientTransportV1 } from '@modelcontextprotocol/sdk/client/stdio.js';

const childEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
  SAP_URL: 'https://dev.example.test',
  SAP_USER: 'SMOKE_USER',
  SAP_PASSWORD: 'not-used',
  SAP_CLIENT: '300',
  SAP_LANGUAGE: 'EN',
  SAP_MCP_SYSTEM_ROLE: 'DEV',
  SAP_MCP_TOOL_PROFILE: 'focused',
  SAP_MCP_ALLOWED_HOSTS: 'dev.example.test',
  SAP_MCP_ALLOWED_CLIENTS: '300',
  SAP_MCP_ALLOWED_NAMESPACES: 'Z,Y'
};

/** 探针 1：裸 server/discover 帧（ZCode auto 协商形态），必须快速明确应答 */
function probeDiscoverFrame() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'], env: childEnv });
    const t0 = Date.now();
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('discover probe timed out after 8000ms')); }, 8_000);
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.includes('supportedVersions')) continue;
        clearTimeout(timer);
        try {
          const msg = JSON.parse(line);
          const versions = msg.result?.supportedVersions;
          const serverInfo = msg.result?._meta?.['io.modelcontextprotocol/serverInfo'];
          child.kill();
          if (Array.isArray(versions) && versions.includes('2026-07-28') && serverInfo?.name === 'abap-ai-workbench-mcp') {
            resolve(Date.now() - t0);
          } else {
            reject(new Error(`unexpected discover result: ${line.slice(0, 300)}`));
          }
          return;
        } catch (error) { child.kill(); reject(error); }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'dual-era-smoke', version: '0' }
      } }
    }) + '\n');
  });
}

async function probeModernSession() {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: childEnv });
  const client = new Client(
    { name: 'dual-era-smoke-modern', version: '0' },
    { capabilities: {}, supportedProtocolVersions: ['2026-07-28', '2025-06-18'], versionNegotiation: { mode: 'auto' } }
  );
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const health = await client.callTool({ name: 'healthcheck', arguments: {} });
    const wireHas2026 = 'ttlMs' in listed && 'cacheScope' in listed;
    return { toolCount: listed.tools.length, wire2026: wireHas2026, healthOk: !health.isError };
  } finally { await client.close(); }
}

async function probeLegacySession() {
  const transport = new StdioClientTransportV1({ command: process.execPath, args: ['dist/index.js'], env: childEnv });
  const client = new ClientV1({ name: 'dual-era-smoke-legacy', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const health = await client.callTool({ name: 'healthcheck', arguments: {} });
    return { toolCount: listed.tools.length, healthOk: !health.isError };
  } finally { await client.close(); }
}

const discoverMs = await probeDiscoverFrame();
const modern = await probeModernSession();
const legacy = await probeLegacySession();
const passed = discoverMs < 8_000
  && modern.wire2026 && modern.healthOk
  && legacy.healthOk
  && modern.toolCount === legacy.toolCount;
process.stdout.write(
  `${passed ? 'PASS' : 'FAIL'} dual-era smoke: discover=${discoverMs}ms, modern(tools=${modern.toolCount}, wire2026=${modern.wire2026}, health=${modern.healthOk}), legacy(tools=${legacy.toolCount}, health=${legacy.healthOk})\n`
);
if (!passed) process.exitCode = 1;
