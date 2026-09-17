/**
 * Dump 增值分析（客户端聚合）——关闭能力矩阵缺口 diagnostics.dumps 的增值半边。
 *
 * 背景：矩阵行 `diagnostics.dumps`（P1 PARTIAL）指出 VSP 的 group_dumps /
 * similar_dumps 增值分析无等价。审计 VSP 实现确认（pkg/adt/dumps.go 第 156 行
 * GroupDumps、internal/mcp/handlers_dumps.go 第 212 行起 similar 语义）：两者
 * 都是对 dumps 列表（ADT ST22 feed）的**纯客户端聚合**，不依赖任何额外端点或
 * SAP helper——因此本文件只做确定性聚合运算，SAP 读取复用既有 RuntimeDumpReader。
 *
 * 聚合语义（对齐 VSP GroupDumps）：
 *   - 分组 key = (异常类型, 终止程序)，两者都来自 dump 的 categories：
 *     label="ABAP runtime error" 的 term 是异常类名（如 CX_SY_ZERODIVIDE），
 *     label="Terminated ABAP program" 的 term 是程序名；
 *   - 每组输出 count、首次/最近时间、涉及用户去重列表；
 *   - 排序：频次降序，并列时最近发生的组排前（"正在发生的比上个月停的更重要"，
 *     对齐 VSP 原注释语义）。
 *
 * similar 语义（对齐 VSP handleSimilarDumps "is this new, and how often does it
 * happen"）：给定异常类型（可选叠加程序过滤），回答窗口内同类 dump 出现次数、
 * 最近一次时间与涉及用户——判断"是首次还是惯犯"。
 */
import type { RuntimeDumpSummary } from './RuntimeDumpReader.js';

/** 一个 dump 条目提取出的聚合维度（对齐 VSP 的分组 key）。 */
export interface DumpFacets {
  /** 异常类型（categories 中 label="ABAP runtime error" 的 term），缺失记 '(unknown)'。 */
  runtimeError: string;
  /** 终止程序（categories 中 label="Terminated ABAP program" 的 term），缺失记 '(unknown)'。 */
  program: string;
  /** 发生时间（published 优先，其次 updated），可能缺失。 */
  at?: Date;
  /** 触发用户（author），可能缺失。 */
  user?: string;
}

/** 一个聚合分组：同一 (异常类型, 程序) 组合的窗口内汇总。 */
export interface DumpGroup {
  runtimeError: string;
  program: string;
  count: number;
  first?: Date;
  last?: Date;
  users: string[];
  /** 组内 dump 的 ST22 条目 id 列表（供后续 get 单条详情追溯）。 */
  dumpIds: string[];
}

export interface DumpGroupResult {
  groups: DumpGroup[];
  /** 窗口内参与聚合的 dump 总数（=各 group.count 之和）。 */
  totalDumps: number;
}

export interface SimilarDumpsResult {
  runtimeError: string;
  program?: string;
  count: number;
  first?: Date;
  last?: Date;
  users: string[];
  /** 命中的 dump 条目（时间正序，便于看演化）。 */
  occurrences: Array<{ id: string; at?: Date; user?: string; program?: string }>;
}

/** 从 categories 提取指定类别的 term 值；缺失返回 undefined。 */
function categoryValue(summary: RuntimeDumpSummary, label: 'ABAP runtime error' | 'Terminated ABAP program'): string | undefined {
  const found = summary.categories.find(category => category.label === label);
  return found?.term || undefined;
}

/** 把一条 dump 摘要提取为聚合维度；时间取 published 优先、其次 updated。 */
export function extractDumpFacets(summary: RuntimeDumpSummary): DumpFacets {
  return {
    runtimeError: categoryValue(summary, 'ABAP runtime error') || '(unknown)',
    program: categoryValue(summary, 'Terminated ABAP program') || '(unknown)',
    at: summary.published ?? summary.updated,
    user: summary.author || undefined
  };
}

/** 比较两个时间：缺省值视为最早（排序时缺时间的条目排尾部）。 */
function timeOrEpoch(at?: Date): number {
  return at ? at.getTime() : 0;
}

/**
 * 窗口内 dump 分组聚合（纯函数，对齐 VSP GroupDumps 的 key/排序语义）。
 * 空输入返回空 groups——聚合失败与空答案不混淆，调用方以 totalDumps 区分。
 */
export function groupRuntimeDumps(dumps: RuntimeDumpSummary[]): DumpGroupResult {
  const index = new Map<string, DumpGroup>();

  for (const summary of dumps) {
    const facets = extractDumpFacets(summary);
    const key = `${facets.runtimeError}\u0000${facets.program}`;
    let group = index.get(key);
    if (!group) {
      group = { runtimeError: facets.runtimeError, program: facets.program, count: 0, users: [], dumpIds: [] };
      index.set(key, group);
    }
    group.count += 1;
    group.dumpIds.push(summary.id);
    if (facets.at) {
      // first/last 取组内最早/最晚（缺时间的条目只计数不参与时间边界）
      if (!group.first || facets.at < group.first) group.first = facets.at;
      if (!group.last || facets.at > group.last) group.last = facets.at;
    }
    if (facets.user && !group.users.includes(facets.user)) group.users.push(facets.user);
  }

  // 频次降序；并列时最近发生的组排前（对齐 VSP 排序语义）
  const groups = [...index.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return timeOrEpoch(b.last) - timeOrEpoch(a.last);
  });
  return { groups, totalDumps: dumps.length };
}

/**
 * 同类 dump 检索（VSP similar_dumps 语义）：在给定 dump 集合内找与
 * runtimeError（可叠加 program 过滤）同类的全部条目，时间正序返回。
 * 答案为空即"窗口内没有同类"——调用方据此判断"是新问题"。
 */
export function findSimilarDumps(
  dumps: RuntimeDumpSummary[],
  runtimeError: string,
  program?: string
): SimilarDumpsResult {
  const wantedError = runtimeError.trim().toUpperCase();
  const wantedProgram = program?.trim().toUpperCase();

  const occurrences: SimilarDumpsResult['occurrences'] = [];
  let first: Date | undefined;
  let last: Date | undefined;
  const users: string[] = [];

  for (const summary of dumps) {
    const facets = extractDumpFacets(summary);
    if (facets.runtimeError.toUpperCase() !== wantedError) continue;
    if (wantedProgram && facets.program.toUpperCase() !== wantedProgram) continue;
    occurrences.push({ id: summary.id, at: facets.at, user: facets.user, program: facets.program });
    if (facets.at) {
      if (!first || facets.at < first) first = facets.at;
      if (!last || facets.at > last) last = facets.at;
    }
    if (facets.user && !users.includes(facets.user)) users.push(facets.user);
  }

  // 时间正序（最早在前），便于阅读问题演化
  occurrences.sort((a, b) => timeOrEpoch(a.at) - timeOrEpoch(b.at));
  return {
    runtimeError: wantedError,
    ...(wantedProgram ? { program: wantedProgram } : {}),
    count: occurrences.length,
    ...(first ? { first } : {}),
    ...(last ? { last } : {}),
    users,
    occurrences
  };
}
