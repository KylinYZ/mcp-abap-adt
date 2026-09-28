import type { TransportHistoryQueryRunner } from './TransportHistoryApi.js';
import { collectTransportScope, TransportScopeInputError } from './TransportScope.js';
import { getLoadGraph, includeBelongsToName } from './LoadGraphApi.js';
import { buildLoadDependencyGraph, type LoadDependencyInput } from './LoadDependencyGraph.js';
import { transportBoundaries } from '../lib/TransportBoundaries.js';
import { dependencyGraphStats, type DependencyNode, type DependencySnapshot } from '../lib/DependencyGraph.js';

export interface TransportLoadBoundaryInput {
  transports: string[];
  maxDependencyQueries?: number;
  maxEntries?: number;
  /** 采集直接出向 D010INC LOADS 边。缺省行为：未给任何开关时为 true（兼容旧调用）。 */
  includeLoadBoundaries?: boolean;
  /** 采集 WBCROSSGT/CROSS 结构边（REFERENCES/CALLS 口径）。两开关不可同时为 false。 */
  includeCrossRefBoundaries?: boolean;
}

function limit(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new TransportScopeInputError(`Budgets must be integers from 1 to ${max}.`);
  }
  return value;
}

const SUPPORTED_LOAD_TYPES = ['CLAS', 'INTF', 'PROG', 'FUGR'];

/** 读取数据单元格（可空/缺键/undefined 按空串，同 TransportScope.cell 的真机语义）。 */
function text(row: Record<string, unknown>, name: string): string {
  const keys = Object.keys(row).filter(key => key.toUpperCase() === name || key.toUpperCase().endsWith(`~${name}`) || key.toUpperCase().endsWith(`.${name}`));
  if (keys.length !== 1) return '';
  const value = row[keys[0]];
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/** quote 输入已过白名单（对象名/成员名），此处引号包裹为纵深防御。 */
const q = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * 交叉引用出边谓词（形态对齐 CrossReferenceApi.buildIncludePredicate）：
 * CLAS/INTF 的 include 是填充池（LIKE '<名>%' 一次捞全，兄弟池行由
 * includeBelongsToName 二次过滤）；PROG 是自身（等值）；FUGR 一律 L<组> 开头。
 */
function crossRefPredicate(type: string, name: string): string {
  if (type === 'PROG') return `INCLUDE = ${q(name)}`;
  if (type === 'FUGR') return `INCLUDE LIKE ${q(`L${name}%`)}`;
  return `INCLUDE LIKE ${q(`${name}%`)}`;
}

interface CrossRefReadResult {
  edges: Array<{ from: DependencyNode; to: DependencyNode; kind: 'REFERENCES' | 'CALLS'; source: 'WBCROSSGT' | 'CROSS' }>;
  /** 两表全部读取失败（此后不再叠加 loads 读——半瞎数据无意义）。 */
  failed: boolean;
}

/**
 * 单成员的 WBCROSSGT/CROSS 出边读取（结构口径，对齐 VSP tr_boundaries 的
 * REFERENCES/CALLS 边源；行语义对齐 CrossReferenceApi：WBCROSSGT 只留
 * DIRECT='X' 行——INDIRECT 是类型引用噪声；CROSS 的 PERFORM 行 NAME/PROG
 * 交换——程序才是可打开对象，form 名降为组件细节（对象级边界图不携带）。
 *
 * 目标身份：命中成员名称集（唯一类型）用成员精确 id；同名多类型是身份歧义
 * （记 issue 不猜）；未命中按 UNKNOWN 类型落图（Z/Y 与命名空间分类由边界
 * 分析器按名称完成）。
 */
async function collectCrossRefOutgoingEdges(
  runQuery: TransportHistoryQueryRunner,
  member: { type: string; name: string },
  memberIndexByName: Map<string, { ids: Set<string>; node: DependencyNode }>,
  nodeId: string,
  reads: { nodeId: string; status: string; rowCount?: number }[],
  issues: { nodeId: string; reason: string }[]
): Promise<CrossRefReadResult> {
  const predicate = crossRefPredicate(member.type, member.name);
  const edges: CrossRefReadResult['edges'] = [];
  const targets = new Map<string, DependencyNode>();
  let wbFailed = false;
  let crossFailed = false;

  const wbRows = await runQuery(`SELECT INCLUDE, OTYPE, NAME, DIRECT FROM WBCROSSGT WHERE ${predicate}`, 2000)
    .then(r => (Array.isArray(r?.values) ? r.values : (issues.push({ nodeId, reason: 'invalid-wbcrossgt-rows' }), [])))
    .catch(() => { wbFailed = true; return []; });
  reads.push({ nodeId, status: wbFailed ? 'failed' : 'ok', rowCount: wbRows.length });
  if (wbFailed) issues.push({ nodeId, reason: 'wbcrossgt-read-failed' });

  const crossRows = await runQuery(`SELECT INCLUDE, TYPE, NAME, PROG FROM CROSS WHERE ${predicate}`, 2000)
    .then(r => (Array.isArray(r?.values) ? r.values : (issues.push({ nodeId, reason: 'invalid-cross-rows' }), [])))
    .catch(() => { crossFailed = true; return []; });
  reads.push({ nodeId, status: crossFailed ? 'failed' : 'ok', rowCount: crossRows.length });
  if (crossFailed) issues.push({ nodeId, reason: 'cross-read-failed' });

  const pushTarget = (name: string): DependencyNode | undefined => {
    const upper = name.trim().toUpperCase();
    if (!upper || upper.length > 80 || !/^[A-Z0-9_/=$%<>~.-]+$/.test(upper)) {
      issues.push({ nodeId, reason: 'unsupported-target-identity' }); return undefined;
    }
    const existing = targets.get(upper);
    if (existing) return existing;
    const hit = memberIndexByName.get(upper);
    let node: DependencyNode;
    if (hit && hit.ids.size === 1) {
      node = { id: hit.ids.values().next().value!, name: upper, type: hit.node.type };
    } else {
      if (hit) issues.push({ nodeId, reason: 'ambiguous-target-membership' });
      node = { id: `UNKNOWN:${upper}`, name: upper, type: 'UNKNOWN' };
    }
    targets.set(upper, node);
    return node;
  };

  for (const row of wbRows) {
    // 引用者归属过滤：INCLUDE LIKE 前缀会拖进兄弟池（ZCL_ORDER_ITEM）
    if (!includeBelongsToName(text(row, 'INCLUDE'), member.name)) continue;
    if (text(row, 'DIRECT') !== 'X') continue;
    // NAME 主段取 \ 前的部分（组件段 ME:DO_STUFF 之类在对象级边界图中不携带）
    const mainName = text(row, 'NAME').split('\\')[0].trim();
    if (!mainName || mainName === member.name) continue;
    const to = pushTarget(mainName);
    if (!to || to.id === nodeId) continue;
    edges.push({ from: { id: nodeId, name: member.name, type: member.type }, to, kind: 'REFERENCES', source: 'WBCROSSGT' });
  }

  for (const row of crossRows) {
    if (!includeBelongsToName(text(row, 'INCLUDE'), member.name)) continue;
    const name = text(row, 'NAME');
    if (!name) continue;
    // PERFORM 行：NAME 是子例程名、PROG 是所属程序——交换后程序才是对象
    const prog = text(row, 'PROG');
    const targetName = prog || name;
    if (targetName === member.name) continue;
    const to = pushTarget(targetName);
    if (!to || to.id === nodeId) continue;
    edges.push({ from: { id: nodeId, name: member.name, type: member.type }, to, kind: 'CALLS', source: 'CROSS' });
  }

  // 两表全部读取失败：不能把"查不了"报告成"没有依赖"（对齐 getCallees 语义）
  if (wbFailed && crossFailed) issues.push({ nodeId, reason: 'crossref-unreadable' });
  return { edges, failed: wbFailed && crossFailed };
}

/** One outgoing read per supported member per source; global budgets, not per-member budgets.
 * Boundary analysis requires only member-origin edges, not expansion of external targets.
 */
export async function collectTransportLoadBoundaries(runQuery: TransportHistoryQueryRunner, input: TransportLoadBoundaryInput) {
  const maxDependencyQueries = limit(input?.maxDependencyQueries, 5, 10);
  const maxEntries = limit(input?.maxEntries, 200, 500);
  // 缺省行为：未给任何开关时 loads 开（兼容旧调用）；显式给 crossref 时 loads 缺省关
  const includeLoad = input?.includeLoadBoundaries ?? (input?.includeCrossRefBoundaries === true ? false : true);
  const includeCrossRef = input?.includeCrossRefBoundaries === true;
  if (!includeLoad && !includeCrossRef) {
    throw new TransportScopeInputError('At least one of includeLoadBoundaries/includeCrossRefBoundaries must be true.');
  }
  const membership = await collectTransportScope(runQuery, input);
  const nodes = new Map(membership.graph.nodes.map(node => [node.id, node]));
  // 目标身份索引：成员名 → 同名成员集合（跨类型同名是身份歧义，不猜）
  const memberIndexByName = new Map<string, { ids: Set<string>; node: DependencyNode }>();
  for (const node of membership.graph.nodes.filter(n => n.type !== 'TR')) {
    const entry = memberIndexByName.get(node.name) ?? { ids: new Set<string>(), node };
    entry.ids.add(node.id);
    memberIndexByName.set(node.name, entry);
  }
  const graph: DependencySnapshot = { nodes: [], edges: [...membership.graph.edges] };
  const edgeKeys = new Set<string>(graph.edges.map(e => `${e.from}->${e.to}|${e.kind}|${e.source}`));
  const issues: { nodeId: string; reason: string }[] = [];
  const skipped: { nodeId: string; reason: string }[] = [];
  const reads: { nodeId: string; status: string; rowCount?: number }[] = [];
  let queryCount = 0;
  for (const nodeId of membership.boundaryScope.objectIds) {
    const node = nodes.get(nodeId)!;
    if (!SUPPORTED_LOAD_TYPES.includes(node.type) || !/^[A-Z0-9_/]{1,40}$/.test(node.name)) {
      skipped.push({ nodeId, reason: 'unsupported-load-identity' }); continue;
    }
    if (queryCount >= maxDependencyQueries) { skipped.push({ nodeId, reason: 'dependency-query-limit' }); continue; }
    if (graph.edges.length >= 2000) { skipped.push({ nodeId, reason: 'graph-edge-limit' }); continue; }

    let crossRefEdges: Awaited<ReturnType<typeof collectCrossRefOutgoingEdges>>['edges'] = [];
    let crossRefFailed = false;
    if (includeCrossRef) {
      if (maxDependencyQueries - queryCount < 2) { skipped.push({ nodeId, reason: 'dependency-query-limit' }); continue; }
      const result = await collectCrossRefOutgoingEdges(runQuery, { type: node.type, name: node.name }, memberIndexByName, nodeId, reads, issues);
      queryCount += 2;
      crossRefEdges = result.edges;
      crossRefFailed = result.failed;
      // crossref 读失败的成员不再叠加 loads 读（半瞎数据无意义），预算让给后续成员
      if (crossRefFailed) { skipped.push({ nodeId, reason: 'crossref-read-failed' }); continue; }
    }
    if (includeLoad) {
      const result = await buildLoadDependencyGraph({ getLoadGraph: args => getLoadGraph(runQuery, args) }, {
        objectType: node.type as LoadDependencyInput['objectType'], objectName: node.name,
        direction: 'loads', maxDepth: 1, maxQueries: 1, maxNodes: 500, maxEdges: 2000
      });
      queryCount += result.collection.queryCount;
      reads.push(...result.collection.reads);
      issues.push(...result.collection.issues);
      if (result.collection.nodeLimitReached) issues.push({ nodeId, reason: 'reader-node-limit' });
      if (result.collection.edgeLimitReached) issues.push({ nodeId, reason: 'reader-edge-limit' });
      for (const frontier of result.collection.unexpanded) {
        if (frontier.reason !== 'depth-limit') issues.push(frontier);
      }
      const fetchedNodes = new Map(result.graph.nodes.map(n => [n.id, n]));
      for (const edge of result.graph.edges) {
        if (graph.edges.length >= 2000) { issues.push({ nodeId, reason: 'graph-edge-limit' }); break; }
        const target = fetchedNodes.get(edge.to)!;
        if (!nodes.has(target.id) && nodes.size >= 500) { issues.push({ nodeId, reason: 'graph-node-limit' }); continue; }
        if (!nodes.has(target.id)) nodes.set(target.id, target);
        const key = `${edge.from}->${edge.to}|${edge.kind}|${edge.source}`;
        if (!edgeKeys.has(key)) { edgeKeys.add(key); graph.edges.push(edge); }
      }
    }
    for (const edge of crossRefEdges) {
      if (graph.edges.length >= 2000) { issues.push({ nodeId, reason: 'graph-edge-limit' }); break; }
      if (!nodes.has(edge.to.id) && nodes.size >= 500) { issues.push({ nodeId, reason: 'graph-node-limit' }); continue; }
      if (!nodes.has(edge.to.id)) nodes.set(edge.to.id, edge.to);
      const key = `${edge.from.id}->${edge.to.id}|${edge.kind}|${edge.source}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        graph.edges.push({ from: edge.from.id, to: edge.to.id, kind: edge.kind, source: edge.source });
      }
    }
  }
  graph.nodes = [...nodes.values()];
  const uniqueIssues = [...new Map(issues.map(i => [`${i.nodeId}:${i.reason}`, i])).values()];
  const analysis = membership.boundaryScope.objectIds.length
    ? transportBoundaries(graph, membership.boundaryScope, maxEntries) : null;
  const partial = membership.collection.status === 'partial' || skipped.length > 0 || uniqueIssues.length > 0;
  const status = partial ? 'partial'
    : includeCrossRef && includeLoad ? 'complete-within-r3tr-reader-scope'
    : includeCrossRef ? 'complete-within-r3tr-crossref-reader-scope'
    : 'complete-within-r3tr-load-reader-scope';
  return {
    scope: !includeCrossRef ? 'explicit-transport-outgoing-loads'
      : includeLoad ? 'explicit-transport-outgoing-structural'
      : 'explicit-transport-outgoing-crossref',
    graph, boundaryScope: membership.boundaryScope,
    stats: dependencyGraphStats(graph), analysis,
    membership: { requested: membership.requested, requests: membership.requests, transports: membership.transports,
      collection: membership.collection },
    collection: {
      status, queryCount: membership.collection.queryCount + queryCount, dependencyQueryCount: queryCount,
      reads, skipped, issues: uniqueIssues,
      limits: { maxDependencyQueries, maxTotalQueries: maxDependencyQueries + 4, maxNodes: 500, maxEdges: 2000, maxEntries }
    },
    systemWideComplete: false, deploymentReadinessVerified: false,
    notes: [
      ...membership.notes,
      includeLoad ? 'Only direct outgoing D010INC LOADS from observed R3TR members are collected. LOADS are not CALLS or all structural dependencies.' : '',
      includeCrossRef ? 'WBCROSSGT/CROSS outgoing edges are collected as REFERENCES/CALLS. Component-level references (methods, forms) merge into object-level edges; INDIRECT WBCROSSGT rows are type-reference noise and are dropped. Each member costs two queries (one per table).' : '',
      includeCrossRef ? 'External target identity resolves by exact name against the member set when unique; otherwise targets land as UNKNOWN-typed nodes classified by the Z/Y naming heuristic. Same-named multi-type members are ambiguous and reported.' : '',
      'Unsupported member types, partial membership and failed/truncated reads prevent complete reader-scope coverage.',
      'External targets are not expanded. Missing custom classifications are provisional when membership is partial.',
      'No package lookup, E070A CR discovery, dynamic-call parsing or release-readiness verification is performed.',
      'A null analysis means no observed R3TR members; an empty report does not prove no dependencies.'
    ].filter(Boolean)
  };
}
