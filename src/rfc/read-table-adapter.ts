import type { TransportAdapter } from './transport';
import {
  buildReadTablePayload,
  validateToken
} from './read-table.js';

/**
 * RFC_READ_TABLE 只读表读取（rfc.remote-enabled.read-table 直链路线）。
 *
 * 经 RFC_READ_TABLE（SAP 标准只读 RFM，allowlist 默认白名单内）读取 DDIC
 * 表/视图数据。按系统接口能力双路径解析（真机实测 2026-09-18）：
 *
 * - S/4 增强 RFM（接口含 USE_ET_DATA_4_RETURN/ET_DATA）：经典 DATA 回填路径
 *   已死（不带开关时 DATA/FIELDS/ET_DATA 全空），必须设 USE_ET_DATA_4_RETURN
 *   ='X'，数据经 ET_DATA[].LINE（按 DELIMITER '|' 分列）返回；FIELDS 仅在
 *   调用方投影时回传列目录。
 * - 经典 RFM（旧系统，接口无该参数）：不能发该开关（open-rfc 请求侧按元
 *   数据校验，未知参数直接拒发 unknown parameter），数据经 DATA[].WA 返回。
 *
 * 能力探测经 TransportAdapter.getFunctionInterface（可选能力）按适配器缓存；
 * 未实现该能力的适配器（Loopback/测试桩）一律走经典路径。
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

/**
 * USE_ET_DATA_4_RETURN 能力探测缓存（按适配器实例）。
 * 缓存探测 Promise：并发调用共享一次元数据往返；探测失败的 Promise 不缓存，
 * 下次调用重新探测（瞬态元数据故障不永久封锁）。
 */
const etDataCapableAdapters = new WeakMap<TransportAdapter, Promise<boolean>>();

/**
 * 探测目标系统的 RFC_READ_TABLE 是否为 S/4 增强形态（含 USE_ET_DATA_4_RETURN
 * 导入参数）。探测失败按传输级错误抛出（连接池据此剔除），不静默降级——
 * 静默降级会在增强系统上得到"0 行成功"的假阴性。
 */
async function supportsEtDataReturn(adapter: TransportAdapter): Promise<boolean> {
  if (typeof adapter.getFunctionInterface !== 'function') return false;
  const cached = etDataCapableAdapters.get(adapter);
  if (cached !== undefined) return cached;
  const probe = adapter.getFunctionInterface('RFC_READ_TABLE')
    .then(iface => iface.parameters.some(p => p.parameterName === 'USE_ET_DATA_4_RETURN'))
    .catch((error: unknown) => {
      etDataCapableAdapters.delete(adapter);
      throw error;
    });
  etDataCapableAdapters.set(adapter, probe);
  return probe;
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
  // S/4 增强形态必须显式要走 ET_DATA 回填（否则经典 DATA 路径全空返回）
  const readTablePayload: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  const etDataMode = await supportsEtDataReturn(adapter);
  if (etDataMode) {
    readTablePayload.USE_ET_DATA_4_RETURN = 'X';
  }
  const invokeResult = await adapter.invoke({
    functionName: 'RFC_READ_TABLE',
    payload: readTablePayload
  });

  // RFC_READ_TABLE 输出（按路径分派）：
  // - 增强：ET_DATA[].LINE = DELIMITER '|' 分隔的整行文本；FIELDS 仅投影时回传
  // - 经典：DATA[].WA = DELIMITER 分隔的整行文本；FIELDS 为实际读取的列定义
  const sourceTable = etDataMode ? 'ET_DATA' : 'DATA';
  const sourceColumn = etDataMode ? 'LINE' : 'WA';
  const dataRows = asRowArray(invokeResult.tables[sourceTable])
    .map(row => String(row[sourceColumn] ?? ''));
  const declaredFields = asRowArray(invokeResult.tables['FIELDS'])
    .map(row => String(row['FIELDNAME'] ?? '').trim())
    .filter(Boolean);
  const columnCount = fields.length > 0
    ? fields.length
    : (declaredFields.length > 0 ? declaredFields.length : 0);
  const parsed = dataRows.map(row => {
    const cells = row.split('|');
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
