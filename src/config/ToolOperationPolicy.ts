import { SafeAbapError } from '../safe/errors.js';
import type { ToolProfile } from '../safe/types.js';

export type ToolOperationClass =
  | 'local'
  | 'read-only'
  | 'source-mutation'
  | 'debug-control'
  | 'advanced-mutation'
  | 'quality-execution'
  | 'other-mutation';

export const RAW_ADVANCED_MUTATION_TOOL_NAMES = new Set([
  'setDomainProperties',
  'setDataElementProperties',
  'setTextElements',
  'changePackageExecute',
  'rapGenGenerate',
  'rapGenPublishService'
]);

export const CONTROLLED_ADVANCED_MUTATION_TOOL_NAMES = new Set([
  'previewDdicPropertyChange', 'applyDdicPropertyChange',
  'previewPackageChange', 'applyPackageChange',
  'previewRapOperation', 'applyRapOperation'
]);

export const CONTROLLED_REPOSITORY_CREATION_TOOL_NAMES = new Set([
  'listRepositoryObjectCreationCapabilities',
  'describeRepositoryObjectCreation',
  'previewRepositoryObjectCreation',
  'applyRepositoryObjectCreation',
  'getRepositoryObjectCreationStatus',
  'previewRepositoryObjectCleanup',
  'applyRepositoryObjectCleanup',
  'getRepositoryObjectCleanupStatus'
]);

/**
 * 受控对象激活工具集合（关闭矩阵缺口 devtools.activate）。
 * 三个工具构成完整受控链：preview（只读收集+冻结 plan）→
 * apply（原生确认后单次激活）→ status（本地查询）。
 * 仅 DEV 角色 + development/development-workbench profile 可用；
 * QAS/PRD/未知角色下隐藏且 dispatch 拒绝。
 */
export const CONTROLLED_ACTIVATION_TOOL_NAMES = new Set([
  'previewObjectActivation',
  'applyObjectActivation',
  'getObjectActivationStatus'
]);

const LOCAL_TOOL_NAMES = new Set([
  'healthcheck', 'getAbapChangeStatus', 'getAbapObjectCreationStatus',
  'getDebugOperationStatus', 'revokeDebugSession', 'getQualityCheckStatus',
  'getRepositoryObjectCreationStatus', 'getRepositoryObjectCleanupStatus',
  'getObjectActivationStatus'
]);

const READ_ONLY_TOOL_NAMES = new Set([
  'sap', 'sapDoctor',
  'transportInfo', 'hasTransportConfig', 'transportConfigurations', 'getTransportConfiguration',
  'userTransports', 'transportsByConfig', 'systemUsers', 'transportReference',
  'objectStructure', 'searchObject', 'findObjectPath', 'objectTypes', 'classIncludes', 'classComponents',
  'syntaxCheckCode', 'syntaxCheckCdsUrl', 'codeCompletion', 'findDefinition', 'usageReferences',
  'syntaxCheckTypes', 'codeCompletionFull', 'codeCompletionElement', 'usageReferenceSnippets',
  'fixProposals', 'fragmentMappings', 'abapDocumentation', 'inactiveObjects', 'objectRegistrationInfo',
  'validateNewObject', 'getObjectSource', 'nodeContents', 'mainPrograms', 'featureDetails', 'collectionFeatureDetails',
  'findCollectionByUrl', 'loadTypes', 'adtDiscovery', 'adtCoreDiscovery', 'adtCompatibiliyGraph',
  'unitTestEvaluation', 'unitTestOccurrenceMarkers', 'prettyPrinterSetting', 'prettyPrinter',
  'gitRepos', 'gitExternalRepoInfo', 'checkRepo', 'remoteRepoInfo', 'ddicElement',
  'ddicRepositoryAccess', 'annotationDefinitions', 'packageSearchHelp', 'bindingDetails',
  'tableContents', 'runQuery', 'feeds', 'dumps', 'debuggerListeners', 'debuggerStackTrace',
  'debuggerVariables', 'debuggerChildVariables', 'atcCustomizing', 'atcCheckVariant', 'atcWorklists',
  'atcUsers', 'isProposalMessage', 'atcContactUri', 'tracesList', 'tracesListRequests',
  'tracesHitList', 'tracesDbAccess', 'tracesStatements', 'renameEvaluate', 'renamePreview',
  'extractMethodEvaluate', 'extractMethodPreview', 'revisions',
  'inspectAbapObject', 'previewAbapChange', 'previewAbapObjectCreation',
  'previewDebugOperation', 'previewDebugVariableChange', 'sm21Read', 'analyzeRuntimeErrors',
  'objectStructureElements', 'typeHierarchy', 'objectEnhancements', 'getDomainProperties',
  'getDataElementProperties', 'getTextElements', 'atcDocumentation', 'changePackagePreview',
  'rapGenValidateInitial', 'rapGenGetSchema', 'rapGenGetContent', 'rapGenGetUiConfig',
  'rapGenValidateContent', 'rapGenPreview', 'rapGenIsAvailable',
  'readRuntimeDumps', 'describeClassicTable', 'inspectSapSystem', 'getAbapMemberSource',
  'listRepositoryObjectCreationCapabilities', 'describeRepositoryObjectCreation', 'previewRepositoryObjectCreation',
  'previewRepositoryObjectCleanup',
  'previewObjectActivation',
  // CDS 依赖分析三工具（能力矩阵 read.cds-analysis 行）：底层仅发只读 ADT GET/
  // usageReferences 查询，归入 read-only 类——QAS/PRD 角色自动可见可用
  'getCdsDependencies', 'getCdsImpactAnalysis', 'getCdsElementInfo',
  // Wave 3 只读分析（矩阵 search.content-grep / read.transaction 邻域 / analysis.callgraph
  // down 方向 / diagnostics.application-log 行）：源码 grep、交叉表 callees、BAL 应用日志
  'grepPackage', 'grepObjects', 'getCallees', 'readApplicationLog',
  // dump 增值分析：ST22 feed 读取后的纯客户端聚合，零额外端点
  'groupRuntimeDumps', 'findSimilarDumps',
  // 依赖上下文四工具（矩阵 codeintel.context 行）：客户端侧压缩/解析/依赖/副作用
  // 分析，SAP 交互仅有只读取源链（searchObject/objectStructure/getObjectSource）
  'getDependencyContext', 'analyzeDependencies', 'parseAbapSource', 'analyzeSourceEffects',
  // UI5/Fiori BSP 只读三工具（矩阵 ui5.read 行）：filestore 列表/文件树/文件内容，
  // 仅三个 GET 端点；ui5.write 方向维持缺口不开放
  'ui5ListApps', 'ui5GetApp', 'ui5GetFileContent',
  // SPOOL/后台作业只读二工具（矩阵 diagnostics.spool-jobs 只读子集）：自由 SQL
  // 查询 TSP01/TST01/TBTCP/TBTCO；作业日志（RFC/XBP）与 spool 内容读取不在内
  'listSpoolRequests', 'listJobs',
  // 消息类文本只读工具（矩阵 read.message-class-texts 行）：messageclass 资源
  // GET，可选 sap-language 语言覆盖；文本写入方向（i18n.write）不开放
  'getMessages',
  // 版本源码只读工具（矩阵 revisions.source 行）：版本标签/序号 → 版本源码 GET，
  // 版本与源 URI 全部服务端解析，不接受任意 URL
  'getRevisionSource',
  // 版本对比只读工具（矩阵 revisions.compare 行）：客户端 LCS unified diff +
  // 增删行计数；版本与源 URI 服务端解析
  'compareRevisions',
  // i18n 按语言只读四工具（矩阵 i18n.read 行语言覆盖部分）：sap-language 覆盖
  // 的只读 GET；文本写入方向（i18n.write）不开放
  'getObjectContentInLanguage', 'getDataElementLabels', 'getTextPoolInLanguage', 'compareObjectLanguages',
  // 包边界只读检查工具（矩阵 analysis.boundaries 行只读子集）：TADIR SELECT +
  // 源码依赖提取 + TADIR 目标包反查；动态调用检测（VSP DYNAMIC）不在子集内
  'checkPackageBoundaries',
  // 对象间源码对比（矩阵 crud.compare-source 行）：双对象当前源码 LCS unified
  // diff；源 URL 服务端解析，不接受任意 URL
  'compareSourceObjects',
  // 事务码元数据只读（矩阵 read.transaction 行）：TSTC/TSTCT 自由 SQL
  //（vit/wb TRAN 端点在该 DEV 无映射）；事务码运行不在此列
  'getTransaction'
]);

const SOURCE_MUTATION_TOOL_NAMES = new Set([
  'setObjectSource', 'deleteObject', 'activateObjects', 'activateByName', 'createObject',
  'createTestInclude', 'fixEdits', 'renameExecute', 'extractMethodExecute',
  'applyAbapChange', 'applyAbapObjectCreation'
]);

const DEBUG_CONTROL_TOOL_NAMES = new Set([
  'debuggerListen', 'debuggerDeleteListener', 'debuggerSetBreakpoints', 'debuggerDeleteBreakpoints',
  'debuggerAttach', 'debuggerSaveSettings', 'debuggerStep', 'debuggerGoToStack',
  'debuggerSetVariableValue', 'applyDebugOperation', 'authorizeDebugSession',
  'executeDebugCommand', 'applyDebugVariableChange'
]);

const OTHER_MUTATION_TOOL_NAMES = new Set([
  'login', 'logout', 'dropSession', 'createTransport', 'setTransportsConfig',
  'createTransportsConfig', 'transportDelete', 'transportRelease', 'transportSetOwner',
  'transportAddUser', 'lock', 'unLock', 'reentranceTicket', 'runClass', 'unitTestRun',
  'setPrettyPrinterSetting', 'gitCreateRepo', 'gitPullRepo', 'gitUnlinkRepo', 'stageRepo',
  'pushRepo', 'switchRepoBranch', 'publishServiceBinding', 'unPublishServiceBinding',
  'createAtcRun', 'atcExemptProposal', 'atcRequestExemption', 'atcChangeContact',
  'tracesSetParameters', 'tracesCreateConfiguration', 'tracesDeleteConfiguration', 'tracesDelete'
]);

const ADVANCED_MUTATION_TOOL_NAMES = new Set([
  ...RAW_ADVANCED_MUTATION_TOOL_NAMES,
  ...CONTROLLED_ADVANCED_MUTATION_TOOL_NAMES,
  'applyRepositoryObjectCreation', 'applyRepositoryObjectCleanup',
  // 受控激活的 apply 属于对象生命周期变更（不动源码），归入 advanced-mutation 而非 source-mutation
  'applyObjectActivation',
  // runUnitCoverage 运行被测对象的用户代码，是执行行为（与 unitTestRun 同级，非只读）
  'runUnitCoverage'
]);

const QUALITY_EXECUTION_TOOL_NAMES = new Set([
  'previewQualityCheck', 'runQualityCheck'
]);

const CLASS_SETS: ReadonlyArray<readonly [ToolOperationClass, Set<string>]> = [
  ['local', LOCAL_TOOL_NAMES],
  ['read-only', READ_ONLY_TOOL_NAMES],
  ['source-mutation', SOURCE_MUTATION_TOOL_NAMES],
  ['debug-control', DEBUG_CONTROL_TOOL_NAMES],
  ['advanced-mutation', ADVANCED_MUTATION_TOOL_NAMES],
  ['quality-execution', QUALITY_EXECUTION_TOOL_NAMES],
  ['other-mutation', OTHER_MUTATION_TOOL_NAMES]
];

export const CLASSIFIED_TOOL_NAMES = new Set(CLASS_SETS.flatMap(([, names]) => [...names]));

export function toolOperationClass(toolName: string): ToolOperationClass | undefined {
  return CLASS_SETS.find(([, names]) => names.has(toolName))?.[0];
}

export function isRawAdvancedMutationTool(toolName: string): boolean {
  return RAW_ADVANCED_MUTATION_TOOL_NAMES.has(toolName);
}

export function isToolAllowedForSystemRole(toolName: string, systemRole: string): boolean {
  const operationClass = toolOperationClass(toolName);
  // 受控创建链与受控激活链即使含只读语义的工具，也只对 DEV 角色可见：
  // 任务链的任何一环都不应在 QAS/PRD/未知角色下面世。
  if (CONTROLLED_REPOSITORY_CREATION_TOOL_NAMES.has(toolName)) return systemRole === 'DEV';
  if (CONTROLLED_ACTIVATION_TOOL_NAMES.has(toolName)) return systemRole === 'DEV';
  return systemRole === 'DEV' || operationClass === 'local' || operationClass === 'read-only';
}

export function assertToolCatalogClassified(toolNames: string[]): void {
  const actual = new Set<string>();
  for (const name of toolNames) {
    if (actual.has(name)) throw new Error(`Duplicate MCP tool name '${name}'.`);
    actual.add(name);
    if (!toolOperationClass(name)) throw new Error(`MCP tool '${name}' has no operation policy classification.`);
  }
  const stale = [...CLASSIFIED_TOOL_NAMES].filter(name => !actual.has(name));
  if (stale.length > 0) throw new Error(`Operation policy contains tools absent from the catalog: ${stale.join(', ')}.`);
}

export function assertToolOperationAllowed(toolName: string, profile: ToolProfile, systemRole: string): void {
  const operationClass = toolOperationClass(toolName);
  if (!operationClass) {
    throw new SafeAbapError('POLICY_DENIED', 'policy', `Tool ${toolName} has no approved operation classification.`);
  }
  if (systemRole !== 'DEV' && operationClass !== 'local' && operationClass !== 'read-only') {
    throw new SafeAbapError(
      'POLICY_DENIED',
      'policy',
      'QAS, PRD, missing, and unknown system roles permit only local and read-only operations.'
    );
  }
  if (RAW_ADVANCED_MUTATION_TOOL_NAMES.has(toolName) && (profile !== 'legacy-full' || systemRole !== 'DEV')) {
    throw new SafeAbapError(
      'POLICY_DENIED',
      'policy',
      'Raw DDIC, package, RAP generation, and publication operations require DEV legacy-full.'
    );
  }
  if (CONTROLLED_ADVANCED_MUTATION_TOOL_NAMES.has(toolName)
    && ((profile !== 'development' && profile !== 'development-workbench') || systemRole !== 'DEV')) {
    throw new SafeAbapError(
      'POLICY_DENIED',
      'policy',
      'Controlled DDIC, package, and RAP operations require DEV development or development-workbench profile.'
    );
  }
  if (CONTROLLED_REPOSITORY_CREATION_TOOL_NAMES.has(toolName)
    && ((profile !== 'development' && profile !== 'development-workbench') || systemRole !== 'DEV')) {
    throw new SafeAbapError(
      'POLICY_DENIED',
      'policy',
      'Controlled repository creation capabilities require DEV development or development-workbench profile.'
    );
  }
  // 受控激活链（devtools.activate 缺口）：仅 DEV + development/development-workbench。
  // 其他 profile（含 legacy-full 专家面）一律 POLICY_DENIED——专家继续使用原子
  // activateObjects/activateByName，不受控激活链不进入 legacy catalog。
  if (CONTROLLED_ACTIVATION_TOOL_NAMES.has(toolName)
    && ((profile !== 'development' && profile !== 'development-workbench') || systemRole !== 'DEV')) {
    throw new SafeAbapError(
      'POLICY_DENIED',
      'policy',
      'Controlled object activation requires DEV development or development-workbench profile.'
    );
  }
  if (QUALITY_EXECUTION_TOOL_NAMES.has(toolName)
    && (profile !== 'development-workbench' || systemRole !== 'DEV')) {
    throw new SafeAbapError(
      'POLICY_DENIED',
      'policy',
      'Quality checks require DEV development-workbench profile.'
    );
  }
}
