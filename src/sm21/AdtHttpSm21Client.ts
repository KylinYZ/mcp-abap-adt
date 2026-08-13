import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Sm21Client, Sm21LogEntry, Sm21ReadRequest, Sm21ReadResult } from './types.js';

// Custom SICF handlers cannot live below the ADT framework resource router.
const SM21_PATH = '/sap/bc/z-mcp/sm21';

export interface AdtHttpRequestClient {
  request(url: string, options: {
    method: 'GET';
    headers: Record<string, string>;
    qs: Record<string, string>;
  }): Promise<{ body: string }>;
}

export class AdtHttpSm21Client implements Sm21Client {
  constructor(private readonly httpClient: AdtHttpRequestClient) {}

  async read(request: Sm21ReadRequest): Promise<Sm21ReadResult> {
    try {
      const response = await this.httpClient.request(SM21_PATH, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        qs: {
          from: request.from,
          to: request.to,
          instances: request.instances.join(','),
          users: request.users.join(','),
          programs: request.programs.join(','),
          tcodes: request.tcodes.join(','),
          messageIds: request.messageIds.join(','),
          severity: request.severity,
          offset: String(request.offset),
          pageSize: String(request.pageSize)
        }
      });
      const payload = parsePayload(response.body);
      if (payload.error) throw new McpError(ErrorCode.InternalError, payload.error);
      return { logs: payload.logs, hasMore: payload.hasMore, total: payload.total };
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        'Unable to read SM21 through the configured ADT HTTP service. Confirm SICF service /sap/bc/z-mcp/sm21 is active and the SAP user has SM21 display authorization.'
      );
    }
  }
}

function parsePayload(body: string): { logs: Sm21LogEntry[]; hasMore: boolean; total: number; error?: string } {
  try {
    const value = JSON.parse(body) as unknown;
    if (!isRecord(value)) throw new Error('invalid payload');
    return {
      logs: readLogs(value.logs),
      hasMore: value.hasMore === true,
      total: readInteger(value.total),
      error: typeof value.error === 'string' && value.error ? value.error : undefined
    };
  } catch {
    throw new McpError(ErrorCode.InternalError, 'The SM21 ADT HTTP service returned an invalid response.');
  }
}

function readLogs(value: unknown): Sm21LogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(entry => {
    const raw = isRecord(entry) ? entry : {};
    return {
      timestamp: readString(raw.timestamp),
      instance: readString(raw.instance),
      client: readString(raw.client),
      user: readString(raw.user),
      program: readString(raw.program),
      tcode: readString(raw.tcode),
      messageId: readString(raw.messageId),
      severity: readString(raw.severity),
      process: readString(raw.process),
      text: readString(raw.text)
    };
  });
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function readInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
