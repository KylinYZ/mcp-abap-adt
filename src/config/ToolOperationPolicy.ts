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

const LOCAL_TOOL_NAMES = new Set([
  'healthcheck', 'getAbapChangeStatus', 'getAbapObjectCreationStatus',
  'getDebugOperationStatus', 'revokeDebugSession', 'getQualityCheckStatus',
  'getRepositoryObjectCreationStatus', 'getRepositoryObjectCleanupStatus'
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
  'previewRepositoryObjectCleanup'
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
  'applyRepositoryObjectCreation', 'applyRepositoryObjectCleanup'
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
  if (CONTROLLED_REPOSITORY_CREATION_TOOL_NAMES.has(toolName)) return systemRole === 'DEV';
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
  if (QUALITY_EXECUTION_TOOL_NAMES.has(toolName)
    && (profile !== 'development-workbench' || systemRole !== 'DEV')) {
    throw new SafeAbapError(
      'POLICY_DENIED',
      'policy',
      'Quality checks require DEV development-workbench profile.'
    );
  }
}
