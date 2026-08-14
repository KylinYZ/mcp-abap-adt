import { SafeAbapError } from '../safe/errors.js';
import type { ToolProfile } from '../safe/types.js';

export type ToolOperationClass =
  | 'local'
  | 'read-only'
  | 'source-mutation'
  | 'debug-control'
  | 'advanced-mutation'
  | 'other-mutation';

export const RAW_ADVANCED_MUTATION_TOOL_NAMES = new Set([
  'setDomainProperties',
  'setDataElementProperties',
  'setTextElements',
  'changePackageExecute',
  'rapGenGenerate',
  'rapGenPublishService'
]);

const LOCAL_TOOL_NAMES = new Set([
  'healthcheck', 'getAbapChangeStatus', 'getAbapObjectCreationStatus',
  'getDebugOperationStatus', 'revokeDebugSession'
]);

const READ_ONLY_TOOL_NAMES = new Set([
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
  'rapGenValidateContent', 'rapGenPreview', 'rapGenIsAvailable'
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

const CLASS_SETS: ReadonlyArray<readonly [ToolOperationClass, Set<string>]> = [
  ['local', LOCAL_TOOL_NAMES],
  ['read-only', READ_ONLY_TOOL_NAMES],
  ['source-mutation', SOURCE_MUTATION_TOOL_NAMES],
  ['debug-control', DEBUG_CONTROL_TOOL_NAMES],
  ['advanced-mutation', RAW_ADVANCED_MUTATION_TOOL_NAMES],
  ['other-mutation', OTHER_MUTATION_TOOL_NAMES]
];

export const CLASSIFIED_TOOL_NAMES = new Set(CLASS_SETS.flatMap(([, names]) => [...names]));

export function toolOperationClass(toolName: string): ToolOperationClass | undefined {
  return CLASS_SETS.find(([, names]) => names.has(toolName))?.[0];
}

export function isRawAdvancedMutationTool(toolName: string): boolean {
  return RAW_ADVANCED_MUTATION_TOOL_NAMES.has(toolName);
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
  if (operationClass === 'advanced-mutation' && (profile !== 'legacy-full' || systemRole !== 'DEV')) {
    throw new SafeAbapError(
      'POLICY_DENIED',
      'policy',
      'Raw DDIC, package, RAP generation, and publication operations require DEV legacy-full.'
    );
  }
}
