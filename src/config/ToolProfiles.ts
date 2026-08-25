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
  'inspectAbapObject', 'previewAbapChange', 'applyAbapChange', 'getAbapChangeStatus',
  'previewAbapObjectCreation', 'applyAbapObjectCreation', 'getAbapObjectCreationStatus',
  'previewDebugOperation', 'applyDebugOperation', 'authorizeDebugSession', 'executeDebugCommand',
  'getDebugOperationStatus', 'revokeDebugSession', 'previewDebugVariableChange', 'applyDebugVariableChange',
  'previewDdicPropertyChange', 'applyDdicPropertyChange', 'previewPackageChange', 'applyPackageChange',
  'previewRapOperation', 'applyRapOperation',
  'readRuntimeDumps', 'describeClassicTable', 'inspectSapSystem', 'getAbapMemberSource',
  'sm21Read', 'analyzeRuntimeErrors', 'healthcheck',
  'transportInfo', 'objectStructure', 'objectStructureElements', 'searchObject', 'findObjectPath',
  'objectTypes', 'classIncludes', 'classComponents', 'syntaxCheckCode', 'syntaxCheckCdsUrl',
  'findDefinition', 'usageReferences', 'usageReferenceSnippets', 'fragmentMappings', 'typeHierarchy',
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
  'previewRepositoryObjectCreation', 'applyRepositoryObjectCreation', 'getRepositoryObjectCreationStatus'
]);

export const BUSINESS_READONLY_TOOL_NAMES = new Set([
  'healthcheck', 'inspectSapSystem', 'describeClassicTable',
  'searchObject', 'findObjectPath', 'objectTypes', 'objectStructure', 'objectStructureElements',
  'annotationDefinitions', 'ddicElement', 'ddicRepositoryAccess', 'getDomainProperties',
  'getDataElementProperties', 'getTextElements', 'bindingDetails', 'tableContents', 'runQuery'
]);

export const OPERATIONS_READONLY_TOOL_NAMES = new Set([
  'healthcheck', 'inspectSapSystem', 'readRuntimeDumps', 'sm21Read', 'analyzeRuntimeErrors',
  'transportInfo', 'hasTransportConfig', 'transportConfigurations', 'getTransportConfiguration',
  'userTransports', 'transportsByConfig', 'systemUsers', 'transportReference',
  'searchObject', 'objectTypes', 'objectStructure', 'objectStructureElements', 'inactiveObjects',
  'atcCustomizing', 'atcCheckVariant', 'atcWorklists', 'atcDocumentation',
  'tracesList', 'tracesListRequests', 'tracesHitList', 'tracesDbAccess', 'tracesStatements',
  'debuggerListeners', 'debuggerStackTrace', 'debuggerVariables', 'debuggerChildVariables',
  'objectEnhancements', 'revisions', 'rapGenValidateInitial', 'rapGenGetSchema', 'rapGenGetContent',
  'rapGenGetUiConfig', 'rapGenValidateContent', 'rapGenPreview', 'rapGenIsAvailable'
]);

export function selectProfileTools(
  profile: ToolProfile,
  safeTools: ToolDefinition[],
  legacyTools: ToolDefinition[],
  runtimeTools: ToolDefinition[] = [],
  safeDebugTools: ToolDefinition[] = [],
  systemRole = 'DEV',
  controlledAdvancedTools: ToolDefinition[] = [],
  qualityTools: ToolDefinition[] = []
): ToolDefinition[] {
  let selected: ToolDefinition[];
  if (profile === 'safe') selected = safeTools;
  else if (profile === 'development') selected = [...safeTools, ...safeDebugTools, ...runtimeTools, ...controlledAdvancedTools, ...readOnlyLegacyTools(legacyTools)];
  else if (profile === 'diagnostic-readonly') {
    selected = [
      ...safeTools.filter(tool => tool.name === 'inspectAbapObject'),
      ...runtimeTools,
      ...readOnlyLegacyTools(legacyTools)
    ];
  } else if (profile === 'legacy-full') {
    const completeTools = [...safeTools, ...runtimeTools, ...legacyTools];
    selected = systemRole === 'DEV'
      ? completeTools
      : completeTools.filter(tool => !isRawAdvancedMutationTool(tool.name));
  } else {
    const completeTools = [
      ...safeTools,
      ...safeDebugTools,
      ...controlledAdvancedTools,
      ...qualityTools,
      ...runtimeTools,
      ...legacyTools
    ];
    const names = profile === 'development-workbench'
      ? DEVELOPMENT_WORKBENCH_TOOL_NAMES
      : profile === 'business-readonly'
        ? BUSINESS_READONLY_TOOL_NAMES
        : OPERATIONS_READONLY_TOOL_NAMES;
    selected = explicitlyNamedTools(profile, completeTools, names);
    if (profile === 'development-workbench') {
      selected.push(...controlledAdvancedTools.filter(tool => (
        tool.name === 'previewRepositoryObjectCleanup'
        || tool.name === 'applyRepositoryObjectCleanup'
        || tool.name === 'getRepositoryObjectCleanupStatus'
      )));
    }
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
