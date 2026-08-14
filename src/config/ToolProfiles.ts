import type { ToolDefinition } from '../types/tools.js';
import type { ToolProfile } from '../safe/types.js';

const READ_ONLY_LEGACY_TOOL_NAMES = new Set([
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
  'extractMethodEvaluate', 'extractMethodPreview', 'revisions', 'healthcheck'
]);

export const READ_ONLY_LEGACY_TOOL_COUNT = READ_ONLY_LEGACY_TOOL_NAMES.size;

export function selectProfileTools(
  profile: ToolProfile,
  safeTools: ToolDefinition[],
  legacyTools: ToolDefinition[],
  runtimeTools: ToolDefinition[] = [],
  safeDebugTools: ToolDefinition[] = []
): ToolDefinition[] {
  if (profile === 'safe') return safeTools;
  if (profile === 'development') return [...safeTools, ...safeDebugTools, ...runtimeTools, ...readOnlyLegacyTools(legacyTools)];
  if (profile === 'diagnostic-readonly') {
    return [
      ...safeTools.filter(tool => tool.name === 'inspectAbapObject'),
      ...runtimeTools,
      ...readOnlyLegacyTools(legacyTools)
    ];
  }
  return [...safeTools, ...runtimeTools, ...legacyTools];
}

export function readOnlyLegacyTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter(tool => READ_ONLY_LEGACY_TOOL_NAMES.has(tool.name));
}

export function isReadOnlyLegacyTool(toolName: string): boolean {
  return READ_ONLY_LEGACY_TOOL_NAMES.has(toolName);
}
