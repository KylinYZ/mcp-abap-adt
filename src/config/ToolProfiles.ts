import type { ToolDefinition } from '../types/tools.js';
import type { ToolProfile } from '../safe/types.js';
import { isRawAdvancedMutationTool, isToolAllowedForSystemRole } from './ToolOperationPolicy.js';

export const READ_ONLY_LEGACY_TOOL_NAMES = new Set([
  'transportInfo', 'hasTransportConfig', 'transportConfigurations', 'getTransportConfiguration',
  'userTransports', 'transportsByConfig', 'systemUsers', 'transportReference',
  'objectStructure', 'searchObject', 'findObjectPath', 'objectTypes', 'classIncludes', 'classComponents',
  'syntaxCheckCode', 'syntaxCheckCdsUrl', 'codeCompletion', 'findDefinition', 'usageReferences',
  'syntaxCheckTypes', 'codeCompletionFull', 'codeCompletionElement', 'usageReferenceSnippets',
  'fixProposals', 'fragmentMappings', 'abapDocumentation',
  'getObjectSource', 'inactiveObjects', 'objectRegistrationInfo', 'validateNewObject', 'nodeContents', 'mainPrograms',
  'featureDetails', 'collectionFeatureDetails', 'findCollectionByUrl', 'loadTypes', 'adtDiscovery',
  'adtCoreDiscovery', 'adtCompatibiliyGraph', 'unitTestEvaluation', 'unitTestOccurrenceMarkers',
  'prettyPrinterSetting', 'prettyPrinter', 'gitRepos', 'gitExternalRepoInfo', 'checkRepo', 'remoteRepoInfo',
  'ddicElement', 'ddicRepositoryAccess', 'annotationDefinitions', 'packageSearchHelp', 'bindingDetails',
  'tableContents', 'runQuery', 'feeds', 'dumps', 'debuggerListeners', 'debuggerStackTrace',
  'debuggerVariables', 'debuggerChildVariables', 'atcCustomizing', 'atcCheckVariant',
  'atcWorklists', 'atcUsers', 'isProposalMessage', 'atcContactUri', 'tracesList', 'tracesListRequests',
  'tracesHitList', 'tracesDbAccess', 'tracesStatements', 'renameEvaluate', 'renamePreview',
  'extractMethodEvaluate', 'extractMethodPreview', 'revisions', 'healthcheck',
  'objectStructureElements', 'typeHierarchy', 'objectEnhancements',
  'getDomainProperties', 'getDataElementProperties', 'getTextElements', 'atcDocumentation',
  'changePackagePreview', 'rapGenValidateInitial', 'rapGenGetSchema', 'rapGenGetContent',
  'rapGenGetUiConfig', 'rapGenValidateContent', 'rapGenPreview', 'rapGenIsAvailable'
]);

export const READ_ONLY_LEGACY_TOOL_COUNT = READ_ONLY_LEGACY_TOOL_NAMES.size;

export const DEVELOPMENT_WORKBENCH_TOOL_NAMES = new Set([
  'sap', 'sapDoctor',
  'inspectAbapObject', 'previewAbapChange', 'applyAbapChange', 'getAbapChangeStatus',
  'previewAbapObjectCreation', 'applyAbapObjectCreation', 'getAbapObjectCreationStatus',
  'previewRepositoryObjectCleanup', 'applyRepositoryObjectCleanup', 'getRepositoryObjectCleanupStatus',
  'previewDebugOperation', 'applyDebugOperation', 'authorizeDebugSession', 'executeDebugCommand',
  'getDebugOperationStatus', 'revokeDebugSession', 'previewDebugVariableChange', 'applyDebugVariableChange',
  'previewDdicPropertyChange', 'applyDdicPropertyChange', 'previewPackageChange', 'applyPackageChange',
  'previewRapOperation', 'applyRapOperation',
  'readRuntimeDumps', 'describeClassicTable', 'inspectSapSystem', 'getAbapMemberSource',
  'sm21Read', 'analyzeRuntimeErrors', 'healthcheck',
  'transportInfo', 'objectStructure', 'objectStructureElements', 'searchObject', 'findObjectPath',
  'objectTypes', 'classIncludes', 'classComponents', 'syntaxCheckCode', 'syntaxCheckCdsUrl',
  'findDefinition', 'usageReferences', 'usageReferenceSnippets', 'fragmentMappings', 'typeHierarchy',
  'unitTestEvaluation',
  'objectEnhancements', 'getObjectSource', 'inactiveObjects', 'mainPrograms', 'annotationDefinitions', 'ddicElement',
  'ddicRepositoryAccess', 'packageSearchHelp', 'getDomainProperties', 'getDataElementProperties',
  'getTextElements', 'bindingDetails', 'tableContents', 'runQuery', 'debuggerListeners',
  'debuggerStackTrace', 'debuggerVariables', 'debuggerChildVariables', 'atcCustomizing',
  'atcCheckVariant', 'atcWorklists', 'atcDocumentation', 'tracesList', 'tracesListRequests',
  'tracesHitList', 'tracesDbAccess', 'tracesStatements', 'changePackagePreview', 'revisions',
  'rapGenValidateInitial', 'rapGenGetSchema', 'rapGenGetContent', 'rapGenGetUiConfig',
  'rapGenValidateContent', 'rapGenPreview', 'rapGenIsAvailable',
  'previewQualityCheck', 'runQualityCheck', 'getQualityCheckStatus',
  'listRepositoryObjectCreationCapabilities', 'describeRepositoryObjectCreation',
  'previewRepositoryObjectCreation', 'applyRepositoryObjectCreation', 'getRepositoryObjectCreationStatus',
  // 受控对象激活链（devtools.activate 缺口）：workbench 面显式收录三工具
  'previewObjectActivation', 'applyObjectActivation', 'getObjectActivationStatus',
  // CDS 依赖分析三工具（read.cds-analysis）：只读诊断能力，workbench 面显式收录
  'getCdsDependencies', 'getCdsImpactAnalysis', 'getCdsElementInfo',
  // Wave 3 分析五工具：源码 grep/交叉引用/应用日志（只读）+ 覆盖率执行（other-mutation）
  'grepPackage', 'grepObjects', 'getCallees', 'readApplicationLog', 'runUnitCoverage',
  // dump 增值分析（diagnostics.dumps）：窗口内分组聚合与同类检索，只读
  'groupRuntimeDumps', 'findSimilarDumps',
  // 依赖上下文四工具（codeintel.context）：客户端侧压缩/解析/依赖/副作用分析，只读
  'getDependencyContext', 'analyzeDependencies', 'parseAbapSource', 'analyzeSourceEffects',
  // UI5/Fiori BSP 只读三工具（ui5.read）：filestore 列表/文件树/文件内容
  'ui5ListApps', 'ui5GetApp', 'ui5GetFileContent',
  // SPOOL/后台作业只读二工具（diagnostics.spool-jobs 只读子集）：自由 SQL 查询
  'listSpoolRequests', 'listJobs', 'readSpoolContent',
  // 消息类文本只读工具（read.message-class-texts）：messageclass 资源 GET
  'getMessages',
  // 版本源码只读工具（revisions.source）：按版本标签/序号读取历史版本源码
  'getRevisionSource',
  // 版本对比只读工具（revisions.compare）：LCS unified diff + 增删行计数
  'compareRevisions',
  // i18n 按语言只读四工具（i18n.read）：对象内容/数据元素标签/文本池/双语对比
  'getObjectContentInLanguage', 'getDataElementLabels', 'getTextPoolInLanguage', 'compareObjectLanguages',
  // 包边界只读检查工具（analysis.boundaries 只读子集）：TADIR 枚举 + 依赖提取
  'checkPackageBoundaries',
  // 对象间源码对比（crud.compare-source）：双对象当前源码 LCS unified diff
  'compareSourceObjects',
  // 事务码元数据只读（read.transaction）：TSTC/TSTCT 自由 SQL
  'getTransaction',
  // 安装前置只读发现（install.diagnostics）：helper TADIR 探测 + abapGit 可达性
  'checkInstallPrerequisites',
  // 知识查询只读三工具（diagnostics.knowledge-queries 子集）：DOKIL/DOKTL
  // 文档 + IMG 检索 + IMG 活动详情（路径递归）
  'getAbapDocumentation', 'searchImgActivities', 'getImgActivity',
  // RFC 直链四工具（rfc.remote-enabled.discovery/read-table/call/describe）：
  // 探测指纹、只读表读取、FM 接口描述、受控只读 RFM 调用
  'probeRfcSystem',
  'readRfcTable',
  'describeRfm',
  'callRfm'
]);

export const BUSINESS_READONLY_TOOL_NAMES = new Set([
  'sapDoctor',
  'healthcheck', 'inspectSapSystem', 'describeClassicTable',
  'searchObject', 'findObjectPath', 'objectTypes', 'objectStructure', 'objectStructureElements',
  'annotationDefinitions', 'ddicElement', 'ddicRepositoryAccess', 'getDomainProperties',
  'getDataElementProperties', 'getTextElements', 'bindingDetails', 'tableContents', 'runQuery'
]);

export const OPERATIONS_READONLY_TOOL_NAMES = new Set([
  'sapDoctor',
  'healthcheck', 'inspectSapSystem', 'readRuntimeDumps', 'sm21Read', 'analyzeRuntimeErrors',
  'transportInfo', 'hasTransportConfig', 'transportConfigurations', 'getTransportConfiguration',
  'userTransports', 'transportsByConfig', 'systemUsers', 'transportReference',
  'searchObject', 'objectTypes', 'objectStructure', 'objectStructureElements', 'inactiveObjects',
  'atcCustomizing', 'atcCheckVariant', 'atcWorklists', 'atcDocumentation',
  'tracesList', 'tracesListRequests', 'tracesHitList', 'tracesDbAccess', 'tracesStatements',
  'debuggerListeners', 'debuggerStackTrace', 'debuggerVariables', 'debuggerChildVariables',
  'objectEnhancements', 'revisions', 'rapGenValidateInitial', 'rapGenGetSchema', 'rapGenGetContent',
  'rapGenGetUiConfig', 'rapGenValidateContent', 'rapGenPreview', 'rapGenIsAvailable',
  // 运维只读面追加应用日志读取（与 sm21Read 同级诊断）与 dump 增值分析
  'readApplicationLog', 'groupRuntimeDumps', 'findSimilarDumps',
  // 版本源码只读（与 revisions 清单同级的运维诊断：核对运行版本与历史差异）
  'getRevisionSource',
  // 版本对比只读（版本间 diff，运维核对运行版本变化）
  'compareRevisions'
]);

export function selectProfileTools(
  profile: ToolProfile,
  safeTools: ToolDefinition[],
  legacyTools: ToolDefinition[],
  runtimeTools: ToolDefinition[] = [],
  safeDebugTools: ToolDefinition[] = [],
  systemRole = 'DEV',
  controlledAdvancedTools: ToolDefinition[] = [],
  qualityTools: ToolDefinition[] = [],
  focusedTools: ToolDefinition[] = [],
  activationTools: ToolDefinition[] = [],
  cdsTools: ToolDefinition[] = [],
  coverageTools: ToolDefinition[] = []
): ToolDefinition[] {
  let selected: ToolDefinition[];
  if (profile === 'safe') selected = safeTools;
  else if (profile === 'development') selected = [
    ...safeTools,
    ...safeDebugTools,
    ...runtimeTools,
    ...controlledAdvancedTools,
    ...activationTools,
    ...cdsTools,
    ...readOnlyLegacyTools(legacyTools)
  ];
  else if (profile === 'diagnostic-readonly') {
    // CDS 依赖分析属只读诊断能力，诊断入口同样收录（QAS/PRD 也可见）
    selected = [
      ...safeTools.filter(tool => tool.name === 'inspectAbapObject'),
      ...runtimeTools,
      ...cdsTools,
      ...readOnlyLegacyTools(legacyTools)
    ];
  } else if (profile === 'legacy-full') {
    // 专家完整面同样包含 CDS 只读分析三工具
    const completeTools = [...safeTools, ...runtimeTools, ...legacyTools, ...cdsTools, ...coverageTools];
    selected = systemRole === 'DEV'
      ? completeTools
      : completeTools.filter(tool => !isRawAdvancedMutationTool(tool.name));
  } else {
    const completeTools = [
      ...safeTools,
      ...safeDebugTools,
      ...controlledAdvancedTools,
      ...qualityTools,
      ...focusedTools,
      ...activationTools,
      ...cdsTools,
      ...coverageTools,
      ...runtimeTools,
      ...legacyTools
    ];
    const names = profile === 'development-workbench'
      ? DEVELOPMENT_WORKBENCH_TOOL_NAMES
      : profile === 'business-readonly'
        ? BUSINESS_READONLY_TOOL_NAMES
        : OPERATIONS_READONLY_TOOL_NAMES;
    selected = explicitlyNamedTools(profile, completeTools, names);
  }
  return systemRole === 'DEV'
    ? selected
    : selected.filter(tool => isToolAllowedForSystemRole(tool.name, systemRole));
}

function explicitlyNamedTools(profile: ToolProfile, tools: ToolDefinition[], names: Set<string>): ToolDefinition[] {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const missing = [...names].filter(name => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`Tool profile '${profile}' references missing tools: ${missing.join(', ')}.`);
  }
  return [...names].map(name => byName.get(name) as ToolDefinition);
}

export function readOnlyLegacyTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter(tool => READ_ONLY_LEGACY_TOOL_NAMES.has(tool.name));
}

export function isReadOnlyLegacyTool(toolName: string): boolean {
  return READ_ONLY_LEGACY_TOOL_NAMES.has(toolName);
}
