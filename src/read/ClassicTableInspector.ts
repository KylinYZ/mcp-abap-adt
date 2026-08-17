import type { ADTClient, QueryResultColumn } from '../adt/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

const CLASSIC_TABLE_NAME = /^(?:\/[A-Z0-9_]{1,10}\/)?[A-Z][A-Z0-9_]*$/;

export class ClassicTableInspector {
  constructor(private readonly client: Pick<ADTClient, 'tableContents'>) {}

  async describe(tableNameInput: unknown): Promise<{ tableName: string; columns: QueryResultColumn[] }> {
    const tableName = normalizeTableName(tableNameInput);
    const sql = `SELECT * FROM ${tableName} WHERE 1 = 0`;
    const result = await this.client.tableContents(tableName, 1, false, sql);
    if (!Array.isArray(result.values) || result.values.length > 0) {
      // Metadata lookup must never become an accidental business-data read.
      throw new Error('Classic table metadata request returned unexpected data rows.');
    }
    if (!Array.isArray(result.columns)) {
      throw new Error('Classic table metadata response did not contain a column list.');
    }
    return {
      tableName,
      columns: result.columns.map(column => ({
        name: column.name,
        type: column.type,
        description: column.description,
        keyAttribute: column.keyAttribute,
        colType: column.colType,
        isKeyFigure: column.isKeyFigure,
        length: column.length
      }))
    };
  }
}

export function normalizeTableName(value: unknown): string {
  if (typeof value !== 'string') throw new McpError(ErrorCode.InvalidParams, 'tableName must be a valid ABAP Dictionary identifier.');
  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized.length > 30 || !CLASSIC_TABLE_NAME.test(normalized)) {
    throw new McpError(ErrorCode.InvalidParams, 'tableName must be a valid ABAP Dictionary identifier of at most 30 characters.');
  }
  return normalized;
}
