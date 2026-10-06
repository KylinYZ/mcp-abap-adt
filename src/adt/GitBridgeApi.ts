import { ApcWebSocketConnection, ApcBridgeOptions } from './ApcWebSocketBridge.js';

/**
 * ============================================================================
 * git 域桥接 API（GitTypes / GitExport）——经 ZADT_VSP APC WebSocket
 * ============================================================================
 *
 * 对接 ZCL_VSP_GIT_SERVICE（VSP embedded 源，abapGit v1.134.0 依赖已部署）：
 *   - get_types：abapGit 支持的对象类型清单（已知问题：部分系统的 INTF
 *     序列化器支持性检查会抛 CX_SY_DYNAMIC_OSQL_SEMANTICS，属 abapGit 运行
 *     时与系统版本的兼容问题，见矩阵 git.abapgit 行 restrictionReason）；
 *   - export：包/对象清单 → abapGit 序列化 → ZIP base64（只读导出）。
 *
 * 生命周期：每次调用独立握手（connect → 单请求 → close），无共享会话；
 * 超时默认 5 分钟（大包导出耗时），上限由调用方护栏控制。
 */

export interface GitBridgeTarget {
  host: string
  port: number
  /** APC 路径（含 sap-client） */
  path: string
  authorization: string
  timeoutMs?: number
}

export interface GitTypesResult {
  count: number
  types: string[]
  serverVersion?: string
}

export interface GitExportInput {
  /** 包名清单（大写，如 Z001、$ZADT_VSP） */
  packages: string[]
  /** 是否含子包（缺省 true，VSP 同款缺省） */
  includeSubpackages?: boolean
}

export interface GitExportResult {
  objectCount: number
  fileCount: number
  zipBase64: string
  files: Array<{ path: string; bytes: number }>
}

/** git 域错误（GIT_ERROR/UNKNOWN_DOMAIN/SERVICE_EXCEPTION 等统一转出）。 */
export class GitBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'GitBridgeError';
  }
}

function requireSuccess(response: Record<string, unknown>): Record<string, unknown> {
  const data = response.data as Record<string, unknown> | undefined;
  if (response.success === true && data) return data;
  const err = response.error as { code?: string; message?: string } | undefined;
  throw new GitBridgeError(
    err?.code ?? 'GIT_BRIDGE_FAILED',
    err?.message ?? 'git domain returned no data'
  );
}

/** git get_types：abapGit 支持的对象类型清单。 */
export async function gitGetTypes(target: GitBridgeTarget): Promise<GitTypesResult> {
  const conn = await ApcWebSocketConnection.connect(target as ApcBridgeOptions);
  try {
    const response = await conn.request(
      { id: 'git-types', domain: 'git', action: 'get_types' },
      target.timeoutMs
    );
    const data = requireSuccess(response);
    const types = Array.isArray(data.types) ? (data.types as string[]) : [];
    return {
      count: typeof data.count === 'number' ? data.count : types.length,
      types,
      ...(typeof data.version === 'string' ? { serverVersion: data.version } : {})
    };
  } finally {
    conn.close();
  }
}

/** git export：包/对象 → abapGit 序列化 ZIP（base64）。 */
export async function gitExport(target: GitBridgeTarget, input: GitExportInput): Promise<GitExportResult> {
  if (!Array.isArray(input.packages) || input.packages.length === 0) {
    throw new GitBridgeError('VALIDATION_FAILED', 'packages must be a non-empty array of package names.');
  }
  const packages = input.packages.map(p => String(p).trim().toUpperCase()).filter(p => p !== '');
  if (packages.length === 0) {
    throw new GitBridgeError('VALIDATION_FAILED', 'packages must contain at least one valid package name.');
  }
  const conn = await ApcWebSocketConnection.connect(target as ApcBridgeOptions);
  try {
    const response = await conn.request(
      {
        id: 'git-export',
        domain: 'git',
        action: 'export',
        params: { packages, includeSubpackages: input.includeSubpackages !== false }
      },
      target.timeoutMs
    );
    const data = requireSuccess(response);
    return {
      objectCount: Number(data.objectCount ?? 0),
      fileCount: Number(data.fileCount ?? 0),
      zipBase64: String(data.zipBase64 ?? ''),
      files: Array.isArray(data.files)
        ? (data.files as Array<{ path?: string; bytes?: number }>).map(f => ({
          path: String(f.path ?? ''),
          bytes: Number(f.bytes ?? 0)
        }))
        : []
    };
  } finally {
    conn.close();
  }
}
