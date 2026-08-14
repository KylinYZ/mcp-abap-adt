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
  'inactiveObjects', 'objectRegistrationInfo', 'validateNewObject', 'nodeContents', 'mainPrograms',
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

export function selectProfileTools(
  profile: ToolProfile,
  safeTools: ToolDefinition[],
  legacyTools: ToolDefinition[],
  runtimeTools: ToolDefinition[] = [],
  safeDebugTools: ToolDefinition[] = [],
  systemRole = 'DEV',
  controlledAdvancedTools: ToolDefinition[] = []
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
  } else {
    const completeTools = [...safeTools, ...runtimeTools, ...legacyTools];
    selected = systemRole === 'DEV'
      ? completeTools
      : completeTools.filter(tool => !isRawAdvancedMutationTool(tool.name));
  }
  return systemRole === 'DEV'
    ? selected
    : selected.filter(tool => isToolAllowedForSystemRole(tool.name, systemRole));
}

export function readOnlyLegacyTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter(tool => READ_ONLY_LEGACY_TOOL_NAMES.has(tool.name));
}

export function isReadOnlyLegacyTool(toolName: string): boolean {
  return READ_ONLY_LEGACY_TOOL_NAMES.has(toolName);
}
