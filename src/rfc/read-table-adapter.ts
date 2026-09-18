import type { TransportAdapter } from './transport';
import {
  buildReadTablePayload,
  validateToken
} from './read-table.js';

/**
 * RFC_READ_TABLE 只读表读取（rfc.remote-enabled.read-table 直链路线）。
 *
 * 经 RFC_READ_TABLE（SAP 标准只读 RFM，allowlist 默认白名单内）读取 DDIC
 * 表/视图数据：DATA 行按 DELIMITER 切分为列值数组。
 */

export { buildReadTablePayload, validateToken } from './read-table.js';

/** 单行 unknown 记录的单元格字符串读取。 */
function cellOf(row: unknown, column: string): string {
  if (typeof row !== 'object' || row === null) return '';
  const value = (row as Record<string, unknown>)[column];
  if (value === undefined || value === null) return '';
  return String(value);
}

/** unknown 数组守卫收敛为行记录数组。 */
function asRowArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null
  );
}

/** readRfcTable 的输入。 */
export interface ReadRfcTableInput {
  /** 目标表名（DDIC 透明表/视图，白名单校验）。 */
  table: string
  /** WHERE 子句（自由文本；单引号自动翻倍转义）。 */
  whereClause?: string
  /** 只取这些列（FIELDNAME 大写白名单校验）。 */
  fields?: readonly string[]
  /** 最大行数（ROWCOUNT；缺省 100，上限 1000）。 */
  maxRows?: number
}

/**
 * 读取 DDIC 表/视图数据（VSP pkg/saprfc/readtable.go ReadTable L27-72 的
 * 调用语义，经 TransportAdapter 抽象执行）。
 *
 * @param adapter 传输适配器（OpenRfcTransport 或 Loopback）
 * @param input table 必填；whereClause/maxRows/fields 可选
 */
export async function readRfcTable(
  adapter: TransportAdapter,
  input: ReadRfcTableInput
): Promise<{
  table: string
  fields: string[]
  rows: string[][]
  rowCount: number
  maxRows: number
}> {
  const capability = 'readRfcTable';
  const maxRows = Math.min(Math.max(Math.floor(Number(input?.maxRows ?? 100)) || 100, 1), 1000);
  const fields: string[] = (input?.fields ?? [])
    .map(f => String(f ?? '').trim().toUpperCase())
    .filter(f => f !== '')
    .map(f => validateToken(f, capability, 'fields entry', 30));

  const { payload, table } = buildReadTablePayload(input, capability);
  const invokeResult = await adapter.invoke({
    functionName: 'RFC_READ_TABLE',
    payload: payload as Readonly<Record<string, unknown>>
  });

  // RFC_READ_TABLE 输出：DATA 表（WA 列 = DELIMITER 分隔的整行文本）、
  // FIELDS 表（实际读取的列定义——FIELDNAME 列名）
  const dataRows = asRowArray(invokeResult.tables['DATA']).map(row => String(row['WA'] ?? ''));
  const declaredFields = asRowArray(invokeResult.tables['FIELDS'])
    .map(row => String(row['FIELDNAME'] ?? '').trim())
    .filter(Boolean);
  const columnCount = fields.length > 0
    ? fields.length
    : (declaredFields.length > 0 ? declaredFields.length : 0);
  const parsed = dataRows.map(row => {
    const cells = row.split('~~');
    while (columnCount > 0 && cells.length < columnCount) cells.push('');
    return cells.slice(0, Math.max(columnCount, cells.length));
  });

  return {
    table: String(table),
    fields: declaredFields.length > 0
      ? declaredFields
      : (fields as string[]),
    rows: parsed,
    rowCount: parsed.length,
    maxRows
  };
}
