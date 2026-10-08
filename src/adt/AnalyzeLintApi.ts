import { ErrorCode, McpError } from '../lib/McpErrorCompat.js';
import type { ToolDefinition } from '../types/tools.js';

/**
 * analyzeLint — 离线 ABAP 静态分析（analysis.lint 行收编）。
 *
 * 本地 abaplint 引擎（@abaplint/core，Apache-2.0）对提交的 ABAP 源码做
 * 完整静态分析：解析错误、语法检查、规则违规（命名/废弃语句/行宽/缩进等）。
 * 纯客户端执行——无 SAP 交互、无网络请求，任意角色/环境可用。
 *
 * 与 VSP 的差异：VSP 走 ZADT_VSP helper 的 abaplint（同引擎）；本实现把
 * 引擎内置为 npm 依赖（@abaplint/core），零 helper 依赖。
 *
 * 默认规则集对齐 abap-mcp-server（Apache-2.0）的 snippet 分析配置：
 * 语法+质量+命名规则开启，噪声规则（abapdoc/缩进细节等）关闭。
 */

/** 输入上限：50KB（abaplint 大模块解析耗时与内存防护）。 */
const MAX_CODE_BYTES = 50 * 1024;
/** 分析超时（abaplint 对病态输入可能长时间解析）。 */
const LINT_TIMEOUT_MS = 10_000;

export interface LintInput {
  code: string
  filename?: string
  version?: 'Standard' | 'Cloud'
  maxFindings?: number
}

export interface LintFinding {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  ruleKey: string;
}

export interface LintResult {
  filename: string
  version: string
  findings: LintFinding[]
  errorCount: number
  warningCount: number
  infoCount: number
  truncated: boolean
  notes: string[]
}

/** 默认规则集（对齐 abap-mcp-server snippet 分析配置；Apache-2.0 attribution）。 */
const DEFAULT_RULES: Record<string, unknown> = {
  // 语法与解析
  parser_error: true,
  check_syntax: true,
  unknown_types: true,
  // 代码质量
  '7bit_ascii': true,
  begin_end_names: true,
  cloud_types: true,
  empty_statement: true,
  empty_structure: true,
  exit_or_check: true,
  functional_writing: true,
  if_in_if: true,
  implement_methods: true,
  indentation: true,
  keyword_case: true,
  line_length: { length: 120 },
  max_one_statement: true,
  method_length: { statements: 100 },
  nesting: { depth: 5 },
  obsolete_statement: true,
  prefer_is_not: true,
  prefer_returning_to_exporting: true,
  prefer_xsdbool: true,
  preferred_compare_operator: true,
  sequential_blank: true,
  short_case: true,
  space_before_colon: true,
  space_before_dot: true,
  sql_escape_host_variables: true,
  try_without_catch: true,
  unreachable_code: true,
  unused_variables: true,
  use_bool_expression: true,
  use_new: true,
  when_others_last: true,
  whitespace_end: true,
  // 命名约定
  class_attribute_names: true,
  local_class_naming: true,
  local_variable_names: true,
  method_parameter_names: true,
  object_naming: true,
  types_naming: true,
  // 关闭（snippet 分析噪声）
  abapdoc: false,
  double_space: false,
  empty_line_in_statement: false,
  in_statement_indentation: false,
  line_break_multiple_parameters: false,
  line_only_punc: false,
  max_one_method_parameter_per_line: false,
  no_public_attributes: false,
  prefer_inline: false,
  remove_descriptions: false,
  downport: false,
  start_at_tab: false,
  newline_between_methods: false,
  colon_missing_space: false,
  contains_tab: false,
  definitions_top: false,
  global_class: false,
  main_file_contents: false
};

/** 从代码内容探测 abapGit 文件名（引擎用扩展名决定解析器）。 */
function detectFilename(code: string, providedFilename?: string): string {
  if (providedFilename && /\.(clas|intf|fugr|prog|ddls|dcls|bdef|srvd|srvb)\.abap$/i.test(providedFilename)) {
    return providedFilename;
  }
  const upper = code.toUpperCase();
  let name = 'code';
  const classMatch = code.match(/CLASS\s+(\w+)\s+DEFINITION/i);
  if (classMatch) return `${classMatch[1]!.toLowerCase()}.clas.abap`;
  const intfMatch = code.match(/INTERFACE\s+(\w+)\s*\./i);
  if (intfMatch) return `${intfMatch[1]!.toLowerCase()}.intf.abap`;
  if (upper.includes('FUNCTION-POOL') || upper.includes('FUNCTION ')) {
    const fm = code.match(/FUNCTION\s+(\w+)/i);
    if (fm) name = fm[1]!.toLowerCase();
    return `${name}.fugr.abap`;
  }
  const reportMatch = code.match(/REPORT\s+(\w+)/i);
  if (reportMatch) return `${reportMatch[1]!.toLowerCase()}.prog.abap`;
  if (upper.includes('DEFINE VIEW') || upper.includes('@ACCESSCONTROL') || upper.includes('DEFINE TABLE FUNCTION')) {
    const cds = code.match(/DEFINE\s+(?:ROOT\s+)?VIEW\s+(?:ENTITY\s+)?(\w+)/i);
    if (cds) name = cds[1]!.toLowerCase();
    return `${name}.ddls.asddls`;
  }
  if (upper.includes('MANAGED IMPLEMENTATION') || upper.includes('UNMANAGED IMPLEMENTATION') || upper.includes('DEFINE BEHAVIOR FOR')) {
    const bd = code.match(/DEFINE\s+BEHAVIOR\s+FOR\s+(\w+)/i);
    if (bd) name = bd[1]!.toLowerCase();
    return `${name}.bdef.asbdef`;
  }
  if (upper.includes('@MAPPINGROLE') || upper.includes('DEFINE ROLE')) {
    return `${name}.dcls.asdcls`;
  }
  return `${name}.clas.abap`;
}

function mapSeverity(sev: string): 'error' | 'warning' | 'info' {
  switch (sev) {
    case 'Error': return 'error';
    case 'Warning': return 'warning';
    default: return 'info';
  }
}

/** 本地 abaplint 分析（含超时保护）。引擎经动态 import（大模块）。 */
export async function analyzeLint(input: LintInput): Promise<LintResult> {
  const code = input.code;
  if (!code.trim()) {
    throw new McpError(ErrorCode.InvalidParams, 'analyzeLint requires code: a non-empty ABAP source string.');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new McpError(ErrorCode.InvalidParams, `analyzeLint: code exceeds the ${MAX_CODE_BYTES / 1024}KB limit (${Buffer.byteLength(code, 'utf8')} bytes).`);
  }
  const filename = detectFilename(code, input.filename);
  const version = input.version ?? 'Standard';
  const maxFindings = input.maxFindings ?? 200;
  const notes: string[] = [];

  const lintPromise = (async () => {
    const abaplint = await import('@abaplint/core');
    const config = {
      global: { files: '/**/*.*' },
      syntax: { version, errorNamespace: '^(Z|Y|LCL_|TY_|LIF_)' },
      rules: DEFAULT_RULES
    };
    const reg = new abaplint.Registry(new abaplint.Config(JSON.stringify(config)));
    reg.addFile(new abaplint.MemoryFile(filename, code));
    await reg.parseAsync();
    const issues = reg.findIssues();
    const findings: LintFinding[] = issues.map(issue => ({
      line: issue.getStart().getRow(),
      column: issue.getStart().getCol(),
      endLine: issue.getEnd().getRow(),
      endColumn: issue.getEnd().getCol(),
      message: issue.getMessage(),
      severity: mapSeverity(issue.getSeverity()),
      ruleKey: issue.getKey()
    }));
    return findings;
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new McpError(ErrorCode.InternalError, `analyzeLint: analysis timed out after ${LINT_TIMEOUT_MS}ms.`)), LINT_TIMEOUT_MS);
  });

  let findings: LintFinding[];
  try {
    findings = await Promise.race([lintPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InternalError, `analyzeLint failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`);
  }

  const truncated = findings.length > maxFindings;
  if (truncated) {
    findings = findings.slice(0, maxFindings);
    notes.push(`Finding count exceeded the ${maxFindings} cap; output truncated. Narrow the input or raise maxFindings.`);
  }

  return {
    filename,
    version,
    findings,
    errorCount: findings.filter(f => f.severity === 'error').length,
    warningCount: findings.filter(f => f.severity === 'warning').length,
    infoCount: findings.filter(f => f.severity === 'info').length,
    truncated,
    notes
  };
}
