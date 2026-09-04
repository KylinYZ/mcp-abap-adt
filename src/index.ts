#!/usr/bin/env node

import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from "@modelcontextprotocol/sdk/types.js";
import { ADTClient, session_types } from "./adt/index.js";
import path from 'path';
import { AuthHandlers } from './handlers/AuthHandlers.js';
import { TransportHandlers } from './handlers/TransportHandlers.js';
import { ObjectHandlers } from './handlers/ObjectHandlers.js';
import { ClassHandlers } from './handlers/ClassHandlers.js';
import { CodeAnalysisHandlers } from './handlers/CodeAnalysisHandlers.js';
import { ObjectLockHandlers } from './handlers/ObjectLockHandlers.js';
import { ObjectSourceHandlers } from './handlers/ObjectSourceHandlers.js';
import { ObjectDeletionHandlers } from './handlers/ObjectDeletionHandlers.js';
import { ObjectManagementHandlers } from './handlers/ObjectManagementHandlers.js';
import { ObjectRegistrationHandlers } from './handlers/ObjectRegistrationHandlers.js';
import { NodeHandlers } from './handlers/NodeHandlers.js';
import { DiscoveryHandlers } from './handlers/DiscoveryHandlers.js';
import { UnitTestHandlers } from './handlers/UnitTestHandlers.js';
import { PrettyPrinterHandlers } from './handlers/PrettyPrinterHandlers.js';
import { GitHandlers } from './handlers/GitHandlers.js';
import { DdicHandlers } from './handlers/DdicHandlers.js';
import { ServiceBindingHandlers } from './handlers/ServiceBindingHandlers.js';
import { QueryHandlers } from './handlers/QueryHandlers.js';
import { FeedHandlers } from './handlers/FeedHandlers.js';
import { DebugHandlers } from './handlers/DebugHandlers.js';
import { RenameHandlers } from './handlers/RenameHandlers.js';
import { AtcHandlers } from './handlers/AtcHandlers.js';
import { TraceHandlers } from './handlers/TraceHandlers.js';
import { RefactorHandlers } from './handlers/RefactorHandlers.js';
import { RevisionHandlers } from './handlers/RevisionHandlers.js';
import { RapGeneratorHandlers } from './handlers/RapGeneratorHandlers.js';
import { Sm21Handlers } from './handlers/Sm21Handlers.js';
import { SafeAbapHandlers } from './handlers/SafeAbapHandlers.js';
import { SafeDebugHandlers } from './handlers/SafeDebugHandlers.js';
import { SafeAdvancedHandlers } from './handlers/SafeAdvancedHandlers.js';
import { SafeQualityHandlers } from './handlers/SafeQualityHandlers.js';
import {
  RepositoryObjectCreationHandlers,
  REPOSITORY_VALIDATION_CLEANUP_TOOL_NAMES
} from './handlers/RepositoryObjectCreationHandlers.js';
import { HighLevelReadHandlers } from './handlers/HighLevelReadHandlers.js';
import { AbapChangeWorkflow } from './safe/AbapChangeWorkflow.js';
import { AbapCreationResolver } from './safe/AbapCreationResolver.js';
import { AbapObjectCreationWorkflow } from './safe/AbapObjectCreationWorkflow.js';
import { AbapObjectResolver } from './safe/AbapObjectResolver.js';
import { AuditLogger } from './safe/AuditLogger.js';
import { ChangePlanStore } from './safe/ChangePlanStore.js';
import { CreationPlanStore } from './safe/CreationPlanStore.js';
import { DebugControlWorkflow } from './safe/DebugControlWorkflow.js';
import { DebugOperationPlanStore } from './safe/DebugOperationPlanStore.js';
import { DebugSessionAuthorizationStore } from './safe/DebugSessionAuthorizationStore.js';
import { AdvancedOperationPlanStore } from './safe/AdvancedOperationPlanStore.js';
import { DdicPropertyChangeWorkflow } from './safe/DdicPropertyChangeWorkflow.js';
import { PackageChangeWorkflow } from './safe/PackageChangeWorkflow.js';
import { RapOperationWorkflow } from './safe/RapOperationWorkflow.js';
import { QualityCheckPlanStore } from './safe/QualityCheckPlanStore.js';
import { QualityCheckWorkflow } from './safe/QualityCheckWorkflow.js';
import { RepositoryObjectCreationRegistry } from './safe/RepositoryObjectCreationRegistry.js';
import { RepositoryObjectCreationPlanStore } from './safe/RepositoryObjectCreationPlanStore.js';
import { RepositoryObjectCreationWorkflow } from './safe/RepositoryObjectCreationWorkflow.js';
import { RepositoryObjectCleanupPlanStore } from './safe/RepositoryObjectCleanupPlanStore.js';
import { RepositoryObjectCleanupWorkflow } from './safe/RepositoryObjectCleanupWorkflow.js';
import { RepositoryCreationConfirmationChallengeStore } from './safe/RepositoryCreationConfirmationChallengeStore.js';
import { createRepositoryCreationConfirmationProvider } from './safe/RepositoryCreationConfirmationProvider.js';
import { INITIAL_REPOSITORY_CREATION_CAPABILITIES } from './safe/repositoryCreationCapabilities.js';
import { PackageCreationAdapter } from './safe/adapters/PackageCreationAdapter.js';
import { DatabaseTableCreationAdapter } from './safe/adapters/DatabaseTableCreationAdapter.js';
import { AbapSourceCreationAdapter, FunctionGroupIncludeCreationAdapter } from './safe/adapters/AbapSourceCreationAdapter.js';
import { FunctionGroupCreationAdapter } from './safe/adapters/FunctionGroupCreationAdapter.js';
import { SourceObjectCreationAdapter } from './safe/adapters/SourceObjectCreationAdapter.js';
import { ServiceBindingCreationAdapter } from './safe/adapters/ServiceBindingCreationAdapter.js';
import { StructureCreationAdapter } from './safe/adapters/StructureCreationAdapter.js';
import { TypeGroupCreationAdapter } from './safe/adapters/TypeGroupCreationAdapter.js';
import { TableTypeCreationAdapter } from './safe/adapters/TableTypeCreationAdapter.js';
import { LockObjectCreationAdapter } from './safe/adapters/LockObjectCreationAdapter.js';
import { LogicalExternalSchemaCreationAdapter } from './safe/adapters/LogicalExternalSchemaCreationAdapter.js';
import { NumberRangeObjectCreationAdapter } from './safe/adapters/NumberRangeObjectCreationAdapter.js';
import { SapObjectTypeCreationAdapter } from './safe/adapters/SapObjectTypeCreationAdapter.js';
import { SapObjectNodeTypeCreationAdapter } from './safe/adapters/SapObjectNodeTypeCreationAdapter.js';
import { ChangeDocumentObjectCreationAdapter } from './safe/adapters/ChangeDocumentObjectCreationAdapter.js';
import { DataElementCreationAdapter, DomainCreationAdapter } from './safe/adapters/DdicPrimitiveCreationAdapter.js';
import { MessageClassCreationAdapter } from './safe/adapters/MessageClassCreationAdapter.js';
import { SafeAbapError } from './safe/errors.js';
import { SafetyPolicy } from './safe/SafetyPolicy.js';
import { RuntimeGuardrails, type RuntimeGuardrailValues } from './config/RuntimeGuardrails.js';
import { ToolExecutionGate } from './lib/ToolExecutionGate.js';
import { adtClientOptions, executeGuardedToolCall, usesSapExecutionGate } from './lib/serverGuardrails.js';
import type { ToolDefinition } from './types/tools.js';
import { sourceCache } from './lib/sourceCache.js';
import { configureLogLevel } from './lib/logger.js';
import { AdtHttpSm21Client } from './sm21/AdtHttpSm21Client.js';
import { sm21ConfigFromEnvironment } from './sm21/config.js';
import { selectProfileTools, isReadOnlyLegacyTool } from './config/ToolProfiles.js';
import { assertToolCatalogClassified, toolOperationClass } from './config/ToolOperationPolicy.js';
import { selectEnvironmentFile } from './config/EnvironmentFile.js';
import { RuntimeDumpReader } from './read/RuntimeDumpReader.js';
import { ClassicTableInspector } from './read/ClassicTableInspector.js';
import { SystemInspector } from './read/SystemInspector.js';
import { AbapMemberSourceReader } from './read/AbapMemberSourceReader.js';
import { SessionSupervisor } from './lib/SessionSupervisor.js';
import { sessionResilienceConfigFromEnvironment, type SessionResilienceConfig } from './config/SessionResilienceConfig.js';
import { resolveSapPassword } from './config/CredentialProvider.js';
import { FocusedTaskHandlers } from './handlers/FocusedTaskHandlers.js';

const environmentFile = selectEnvironmentFile(
  process.env.SAP_MCP_ENV_FILE,
  process.cwd(),
  path.resolve(__dirname, '../.env')
);
const environmentLoad = config({ path: environmentFile.path });
if (environmentFile.explicit && environmentLoad.error) {
  throw new Error(`Failed to load SAP_MCP_ENV_FILE: ${environmentLoad.error.message}`);
}

export class AbapAdtServer extends Server {
  private adtClient: ADTClient;
  private sessionSupervisor?: SessionSupervisor;
  private safetyPolicy: SafetyPolicy;
  private readonly guardrails: RuntimeGuardrailValues;
  private readonly executionGate: ToolExecutionGate;
  private readonly sessionResilience: SessionResilienceConfig;
  private toolCatalog: ToolDefinition[] = [];
  private safeAbapHandlers: SafeAbapHandlers;
  private safeDebugHandlers: SafeDebugHandlers;
  private safeAdvancedHandlers: SafeAdvancedHandlers;
  private safeQualityHandlers: SafeQualityHandlers;
  private repositoryObjectCreationHandlers: RepositoryObjectCreationHandlers;
  private highLevelReadHandlers: HighLevelReadHandlers;
  private focusedTaskHandlers: FocusedTaskHandlers;
  private authHandlers: AuthHandlers;
  private transportHandlers: TransportHandlers;
  private objectHandlers: ObjectHandlers;
  private classHandlers: ClassHandlers;
  private codeAnalysisHandlers: CodeAnalysisHandlers;
  private objectLockHandlers: ObjectLockHandlers;
  private objectSourceHandlers: ObjectSourceHandlers;
  private objectDeletionHandlers: ObjectDeletionHandlers;
  private objectManagementHandlers: ObjectManagementHandlers;
  private objectRegistrationHandlers: ObjectRegistrationHandlers;
    private nodeHandlers: NodeHandlers;
    private discoveryHandlers: DiscoveryHandlers;
    private unitTestHandlers: UnitTestHandlers;
    private prettyPrinterHandlers: PrettyPrinterHandlers;
    private gitHandlers: GitHandlers;
    private ddicHandlers: DdicHandlers;
    private serviceBindingHandlers: ServiceBindingHandlers;
    private queryHandlers: QueryHandlers;
    private feedHandlers: FeedHandlers;
    private debugHandlers: DebugHandlers;
    private renameHandlers: RenameHandlers;
    private atcHandlers: AtcHandlers;
    private traceHandlers: TraceHandlers;
    private refactorHandlers: RefactorHandlers;
    private revisionHandlers: RevisionHandlers;
    private rapGeneratorHandlers: RapGeneratorHandlers;
    private sm21Handlers?: Sm21Handlers;

  constructor(passwordOverride?: string) {
    super(
      {
        name: "mcp-abap-abap-adt-api",
        version: "0.4.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.guardrails = RuntimeGuardrails.fromEnvironment();
    this.sessionResilience = sessionResilienceConfigFromEnvironment();
    configureLogLevel(this.guardrails.logLevel);
    this.executionGate = new ToolExecutionGate(this.guardrails.maxConcurrentTools, this.guardrails.maxQueuedTools);
    sourceCache.configure({
      maxEntries: this.guardrails.sourceCacheMaxEntries,
      maxItemBytes: this.guardrails.sourceCacheMaxItemBytes,
      ttlMs: this.guardrails.sourceCacheTtlMs
    });
    const sapPassword = passwordOverride || process.env.SAP_PASSWORD;
    const missingVars = ['SAP_URL', 'SAP_USER'].filter(v => !process.env[v]);
    if (!sapPassword) missingVars.push('SAP_PASSWORD (or external credential provider)');
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
    
    this.adtClient = new ADTClient(
      process.env.SAP_URL as string,
      process.env.SAP_USER as string,
      sapPassword as string,
      process.env.SAP_CLIENT as string,
      process.env.SAP_LANGUAGE as string,
      {
        ...adtClientOptions(this.guardrails),
        sessionEventCallback: event => this.sessionSupervisor?.handleEvent(event)
      }
    );
    this.adtClient.stateful = session_types.stateful
    this.sessionSupervisor = new SessionSupervisor(this.adtClient, {
      enabled: this.sessionResilience.sessionRecovery
    });
    this.safetyPolicy = SafetyPolicy.fromEnvironment();
    const repositoryCreationContext = {
      systemHost: this.safetyPolicy.systemHost,
      client: this.safetyPolicy.client,
      sapUser: this.safetyPolicy.sapUser,
      systemRole: this.safetyPolicy.systemRole,
      toolProfile: this.safetyPolicy.toolProfile,
      realDevValidationEnabled: this.safetyPolicy.realDevValidationEnabled,
      realDevValidationObjects: [...this.safetyPolicy.realDevValidationObjects],
      realDevValidationPrefix: this.safetyPolicy.realDevValidationPrefix,
      realDevValidationPackage: this.safetyPolicy.realDevValidationPackage,
      realDevValidationTransport: this.safetyPolicy.realDevValidationTransport
    };
    const repositoryCreationRegistry = new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES);
    const sm21Config = sm21ConfigFromEnvironment();
    
    // Initialize handlers
    this.authHandlers = new AuthHandlers(this.adtClient);
    this.transportHandlers = new TransportHandlers(this.adtClient);
    this.objectHandlers = new ObjectHandlers(this.adtClient);
    this.classHandlers = new ClassHandlers(this.adtClient);
    this.codeAnalysisHandlers = new CodeAnalysisHandlers(this.adtClient);
    this.objectLockHandlers = new ObjectLockHandlers(this.adtClient);
    this.objectSourceHandlers = new ObjectSourceHandlers(this.adtClient);
    this.objectDeletionHandlers = new ObjectDeletionHandlers(this.adtClient);
    this.objectManagementHandlers = new ObjectManagementHandlers(this.adtClient);
    this.objectRegistrationHandlers = new ObjectRegistrationHandlers(this.adtClient);
    this.nodeHandlers = new NodeHandlers(this.adtClient);
    this.discoveryHandlers = new DiscoveryHandlers(this.adtClient);
    this.unitTestHandlers = new UnitTestHandlers(this.adtClient);
    this.prettyPrinterHandlers = new PrettyPrinterHandlers(this.adtClient);
    this.gitHandlers = new GitHandlers(this.adtClient);
    this.ddicHandlers = new DdicHandlers(this.adtClient);
    this.serviceBindingHandlers = new ServiceBindingHandlers(this.adtClient);
    this.queryHandlers = new QueryHandlers(this.adtClient);
    this.feedHandlers = new FeedHandlers(this.adtClient);
    this.debugHandlers = new DebugHandlers(this.adtClient);
    this.renameHandlers = new RenameHandlers(this.adtClient);
    this.atcHandlers = new AtcHandlers(this.adtClient);
    this.traceHandlers = new TraceHandlers(this.adtClient);
    this.refactorHandlers = new RefactorHandlers(this.adtClient);
    this.revisionHandlers = new RevisionHandlers(this.adtClient);
    this.rapGeneratorHandlers = new RapGeneratorHandlers(this.adtClient);
    const readClient = this.sessionResilience.statelessReads
      ? this.adtClient.statelessClone
      : this.adtClient;
    const objectResolver = new AbapObjectResolver(this.adtClient);
    const readObjectResolver = this.sessionResilience.statelessReads
      ? new AbapObjectResolver(readClient)
      : objectResolver;
    this.highLevelReadHandlers = new HighLevelReadHandlers(
      new RuntimeDumpReader(readClient),
      new ClassicTableInspector(readClient),
      new SystemInspector(readClient, {
        host: this.safetyPolicy.systemHost,
        client: this.safetyPolicy.client,
        toolProfile: this.safetyPolicy.toolProfile,
        systemRole: this.safetyPolicy.systemRole
      }),
      new AbapMemberSourceReader(readClient, readObjectResolver)
    );
    // SM21 is read-only; it follows the stateless read rollout switch when enabled.
    this.sm21Handlers = new Sm21Handlers(new AdtHttpSm21Client(readClient.httpClient), sm21Config, readClient);
    const changePlans = new ChangePlanStore(
      this.safetyPolicy.planTtlMs,
      () => Date.now(),
      undefined,
      this.guardrails.changePlanMaxEntries,
      this.guardrails.rollbackFailedRetentionMs
    );
    const auditLogger = new AuditLogger(
      this.safetyPolicy.auditPath || path.resolve(process.cwd(), '.sap-mcp-audit-disabled')
    );
    const changeWorkflow = new AbapChangeWorkflow(
      this.adtClient,
      objectResolver,
      this.safetyPolicy,
      changePlans,
      auditLogger
    );
    const creationWorkflow = new AbapObjectCreationWorkflow(
      this.adtClient,
      new AbapCreationResolver(this.adtClient, this.safetyPolicy),
      this.safetyPolicy,
      new CreationPlanStore(
        this.safetyPolicy.planTtlMs,
        () => Date.now(),
        undefined,
        this.guardrails.changePlanMaxEntries,
        this.guardrails.rollbackFailedRetentionMs
      ),
      auditLogger
    );
    const repositoryCreationWorkflow = new RepositoryObjectCreationWorkflow(
      repositoryCreationRegistry,
      repositoryCreationContext,
      new RepositoryObjectCreationPlanStore(
        this.safetyPolicy.planTtlMs,
        () => Date.now(),
        undefined,
        this.guardrails.changePlanMaxEntries
      ),
      [
        new AbapSourceCreationAdapter('PROGRAM', creationWorkflow),
        new FunctionGroupCreationAdapter(creationWorkflow),
        new AbapSourceCreationAdapter('FUNCTION_MODULE', creationWorkflow),
        new FunctionGroupIncludeCreationAdapter(creationWorkflow),
        new PackageCreationAdapter(this.adtClient, this.safetyPolicy),
        new DatabaseTableCreationAdapter(this.adtClient, this.safetyPolicy),
        new StructureCreationAdapter(this.adtClient, this.safetyPolicy),
        new TypeGroupCreationAdapter(this.adtClient, this.safetyPolicy),
        new TableTypeCreationAdapter(this.adtClient, this.safetyPolicy),
        new LockObjectCreationAdapter(this.adtClient, this.safetyPolicy),
        new LogicalExternalSchemaCreationAdapter(this.adtClient, this.safetyPolicy),
        new NumberRangeObjectCreationAdapter(this.adtClient, this.safetyPolicy),
        new SapObjectTypeCreationAdapter(this.adtClient, this.safetyPolicy),
        new SapObjectNodeTypeCreationAdapter(this.adtClient, this.safetyPolicy),
        new ChangeDocumentObjectCreationAdapter(this.adtClient, this.safetyPolicy),
        new DomainCreationAdapter(this.adtClient, this.safetyPolicy),
        new DataElementCreationAdapter(this.adtClient, this.safetyPolicy),
        new MessageClassCreationAdapter(this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('ABAP_CLASS', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('ABAP_INTERFACE', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('PROGRAM_INCLUDE', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('CDS_DATA_DEFINITION', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('CDS_ACCESS_CONTROL', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('CDS_METADATA_EXTENSION', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('CDS_ANNOTATION_DEFINITION', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('SERVICE_DEFINITION', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('BEHAVIOR_DEFINITION', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('CDS_TYPE', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('CDS_ASPECT', this.adtClient, this.safetyPolicy),
        new SourceObjectCreationAdapter('CDS_ENTITY_BUFFER', this.adtClient, this.safetyPolicy),
        new ServiceBindingCreationAdapter(this.adtClient, this.safetyPolicy)
      ]
    );
    const repositoryConfirmationSessionId = randomUUID();
    const repositoryConfirmationChallenges = new RepositoryCreationConfirmationChallengeStore();
    const repositoryConfirmationProvider = createRepositoryCreationConfirmationProvider({
      environment: process.env,
      platform: process.platform,
      supportsFormElicitation: () => Boolean(this.getClientCapabilities()?.elicitation?.form),
      elicitInput: (params, timeoutMs) => this.elicitInput(params, { timeout: timeoutMs })
    });
    const repositoryCleanupWorkflow = new RepositoryObjectCleanupWorkflow(
      this.adtClient,
      repositoryCreationRegistry,
      repositoryCreationContext,
      new RepositoryObjectCleanupPlanStore(
        this.safetyPolicy.planTtlMs,
        () => Date.now(),
        undefined,
        this.guardrails.changePlanMaxEntries
      )
    );
    this.repositoryObjectCreationHandlers = new RepositoryObjectCreationHandlers(
      repositoryCreationRegistry,
      repositoryCreationContext,
      repositoryCreationWorkflow,
      {
        provider: repositoryConfirmationProvider,
        challengeStore: repositoryConfirmationChallenges,
        sessionId: repositoryConfirmationSessionId,
        applyConfirmed: creationPlanId => this.executionGate.run(() => repositoryCreationWorkflow.apply(creationPlanId)),
        audit: event => auditLogger.append({
          correlationId: `repository-confirmation:${event.plan.creationPlanId}`,
          creationPlanId: event.plan.creationPlanId,
          eventType: `REPOSITORY_CREATION_CONFIRMATION_${event.challengeStatus}`,
          systemHost: event.plan.systemHost,
          client: event.plan.client,
          systemRole: event.plan.systemRole,
          objectType: event.plan.target.objectKind,
          objectName: event.plan.target.objectName,
          parentObject: event.plan.target.parentName,
          packageName: event.plan.target.packageName || event.plan.target.parentName,
          transportRequest: event.plan.transportRequest,
          targetHash: event.plan.payloadHash,
          confirmationMode: event.providerMode,
          resultSummary: event.action,
          success: event.challengeStatus !== 'CANCELLED'
        })
      },
      repositoryCleanupWorkflow,
      {
        provider: repositoryConfirmationProvider,
        sessionId: `${repositoryConfirmationSessionId}:cleanup`,
        applyConfirmed: cleanupPlanId => this.executionGate.run(() => repositoryCleanupWorkflow.apply(cleanupPlanId)),
        audit: event => auditLogger.append({
          correlationId: `repository-cleanup-confirmation:${event.plan.cleanupPlanId}`,
          creationPlanId: event.plan.cleanupPlanId,
          eventType: `REPOSITORY_CLEANUP_CONFIRMATION_${event.challengeStatus}`,
          systemHost: event.plan.systemHost,
          client: event.plan.client,
          systemRole: event.plan.systemRole,
          objectType: event.plan.target.objectKind,
          objectName: event.plan.target.objectName,
          packageName: event.plan.target.packageName,
          transportRequest: event.plan.transportRequest,
          targetHash: event.plan.payloadHash,
          confirmationMode: event.providerMode,
          resultSummary: event.action,
          success: event.challengeStatus !== 'CANCELLED'
        })
      }
    );
    this.safeAbapHandlers = new SafeAbapHandlers(changeWorkflow, {
      allowTextConfirmation: this.safetyPolicy.allowTextConfirmation,
      supportsFormElicitation: () => Boolean(this.getClientCapabilities()?.elicitation?.form),
      elicitInput: (params, timeoutMs) => this.elicitInput(params, { timeout: timeoutMs }),
      applyConfirmed: input => this.executionGate.run(() => changeWorkflow.apply(input))
    }, creationWorkflow, {
      allowTextConfirmation: this.safetyPolicy.allowTextConfirmation,
      supportsFormElicitation: () => Boolean(this.getClientCapabilities()?.elicitation?.form),
      elicitInput: (params, timeoutMs) => this.elicitInput(params, { timeout: timeoutMs }),
      applyConfirmed: input => this.executionGate.run(() => creationWorkflow.apply(input))
    });
    const debugWorkflow = new DebugControlWorkflow(
      this.adtClient,
      this.safetyPolicy,
      new DebugOperationPlanStore(
        this.safetyPolicy.planTtlMs,
        () => Date.now(),
        undefined,
        this.guardrails.changePlanMaxEntries
      ),
      new DebugSessionAuthorizationStore(
        this.safetyPolicy.debugAuthTtlMs,
        () => Date.now(),
        undefined,
        this.guardrails.changePlanMaxEntries
      ),
      auditLogger
    );
    this.safeDebugHandlers = new SafeDebugHandlers(debugWorkflow, {
      supportsFormElicitation: () => Boolean(this.getClientCapabilities()?.elicitation?.form),
      elicitInput: (params, timeoutMs) => this.elicitInput(params, { timeout: timeoutMs }),
      applyConfirmed: input => this.executionGate.run(() => debugWorkflow.applyOperation(input)),
      authorizeConfirmed: (targetUser, debuggeeId) => this.executionGate.run(
        () => debugWorkflow.authorizeConfirmed(targetUser, debuggeeId)
      )
    });

    const advancedPlans = new AdvancedOperationPlanStore(
      this.safetyPolicy.planTtlMs,
      () => Date.now(),
      undefined,
      this.guardrails.changePlanMaxEntries
    );
    const ddicWorkflow = new DdicPropertyChangeWorkflow(this.adtClient, this.safetyPolicy, advancedPlans, auditLogger);
    const packageWorkflow = new PackageChangeWorkflow(this.adtClient, objectResolver, this.safetyPolicy, advancedPlans, auditLogger);
    const rapWorkflow = new RapOperationWorkflow(this.adtClient, this.safetyPolicy, advancedPlans, auditLogger);
    this.safeAdvancedHandlers = new SafeAdvancedHandlers({
      status: operationPlanId => advancedPlans.view(operationPlanId, {
        systemHost: this.safetyPolicy.systemHost,
        client: this.safetyPolicy.client,
        systemRole: this.safetyPolicy.systemRole,
        toolProfile: this.safetyPolicy.toolProfile
      }),
      previewDdicPropertyChange: args => ddicWorkflow.preview(args),
      previewPackageChange: args => packageWorkflow.preview(args),
      previewRapOperation: args => rapWorkflow.preview(args)
    }, {
      supportsFormElicitation: () => Boolean(this.getClientCapabilities()?.elicitation?.form),
      elicitInput: (params, timeoutMs) => this.elicitInput(params, { timeout: timeoutMs }),
      applyConfirmed: operationPlanId => this.executionGate.run(async () => {
        const plan = advancedPlans.get(operationPlanId);
        if (plan.operationKind === 'CHANGE_PACKAGE') return packageWorkflow.apply(operationPlanId);
        if (plan.operationKind === 'RAP_GENERATE' || plan.operationKind === 'RAP_PUBLISH_SERVICE') return rapWorkflow.apply(operationPlanId);
        return ddicWorkflow.apply(operationPlanId);
      })
    });

    const qualityPlans = new QualityCheckPlanStore(
      this.safetyPolicy.planTtlMs,
      () => Date.now(),
      undefined,
      this.guardrails.changePlanMaxEntries
    );
    const qualityWorkflow = new QualityCheckWorkflow(
      this.adtClient,
      objectResolver,
      this.safetyPolicy,
      qualityPlans,
      auditLogger
    );
    this.safeQualityHandlers = new SafeQualityHandlers(qualityWorkflow, {
      supportsFormElicitation: () => Boolean(this.getClientCapabilities()?.elicitation?.form),
      elicitInput: (params, timeoutMs) => this.elicitInput(params, { timeout: timeoutMs }),
      runConfirmed: qualityPlanId => this.executionGate.run(() => qualityWorkflow.run(qualityPlanId))
    });

    this.focusedTaskHandlers = new FocusedTaskHandlers(
      (toolName, argumentsValue) => this.executionGate.run(() => this.dispatchTool(toolName, argumentsValue)),
      () => this.healthcheckResult()
    );


        // Setup tool handlers
    this.toolCatalog = this.createToolCatalog();
    this.setupToolHandlers();
  }

  private serializeResult(result: unknown) {
    try {
      // Handlers already return a well-formed MCP tool result
      // ({ content: [...] }). Re-wrapping it would double-serialize the payload
      // (every quote in the data gets escaped again), needlessly inflating large
      // responses such as object source (issue #4). Pass those through as-is and
      // only wrap raw values (e.g. the healthcheck object).
      if (typeof result === 'object' && result !== null && 'content' in result && Array.isArray(result.content)) {
        return result;
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
          )
        }]
      };
    } catch (error) {
      return this.handleError(new McpError(
        ErrorCode.InternalError,
        'Failed to serialize result'
      ));
    }
  }

  private handleError(error: unknown) {
    if (!(error instanceof Error)) {
      error = new Error(String(error));
    }
    if (error instanceof SafeAbapError) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(error.toResponse())
        }],
        isError: true
      };
    }
    if (error instanceof McpError) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error.message,
            code: error.code
          })
        }],
        isError: true
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Internal server error',
          code: ErrorCode.InternalError
        })
      }],
      isError: true
    };
  }

  private setupToolHandlers() {
    this.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: this.toolCatalog };
    });

    this.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      return executeGuardedToolCall(
        request.params.name,
        (request.params.arguments || {}) as Record<string, unknown>,
        this.guardrails,
        this.executionGate,
        usesSapExecutionGate(request.params.name),
        limitedArguments => this.sessionSupervisor
          ? this.sessionSupervisor.execute(
            request.params.name,
            () => this.dispatchTool(request.params.name, limitedArguments, extra.signal)
          )
          : this.dispatchTool(request.params.name, limitedArguments, extra.signal),
        result => this.serializeResult(result),
        error => this.handleError(error)
      );
    });
  }

  private createToolCatalog(): ToolDefinition[] {
    const safeTools = this.safeAbapHandlers.getTools();
    const safeDebugTools = this.safeDebugHandlers.getTools();
    const completeControlledAdvancedTools = [
      ...this.safeAdvancedHandlers.getTools(),
      ...this.repositoryObjectCreationHandlers.getTools(true)
    ];
    // Cleanup tools are catalogued for policy completeness but never exposed outside validation.
    const controlledAdvancedTools = completeControlledAdvancedTools.filter(tool => (
      this.safetyPolicy.realDevValidationEnabled || !REPOSITORY_VALIDATION_CLEANUP_TOOL_NAMES.has(tool.name)
    ));
    const qualityTools = this.safeQualityHandlers.getTools();
    const sm21Tools = this.sm21Handlers?.getTools() || [];
    const runtimeTools = [...this.highLevelReadHandlers.getTools(), ...sm21Tools];
    const focusedTools = this.focusedTaskHandlers.getTools();
    const legacyTools = [
        ...this.authHandlers.getTools(),
        ...this.transportHandlers.getTools(),
        ...this.objectHandlers.getTools(),
        ...this.classHandlers.getTools(),
        ...this.codeAnalysisHandlers.getTools(),
        ...this.objectLockHandlers.getTools(),
        ...this.objectSourceHandlers.getTools(),
        ...this.objectDeletionHandlers.getTools(),
        ...this.objectManagementHandlers.getTools(),
        ...this.objectRegistrationHandlers.getTools(),
        ...this.nodeHandlers.getTools(),
        ...this.discoveryHandlers.getTools(),
        ...this.unitTestHandlers.getTools(),
        ...this.prettyPrinterHandlers.getTools(),
        ...this.gitHandlers.getTools(),
        ...this.ddicHandlers.getTools(),
        ...this.serviceBindingHandlers.getTools(),
        ...this.queryHandlers.getTools(),
        ...this.feedHandlers.getTools(),
        ...this.debugHandlers.getTools(),
        ...this.renameHandlers.getTools(),
        ...this.atcHandlers.getTools(),
        ...this.traceHandlers.getTools(),
        ...this.refactorHandlers.getTools(),
        ...this.revisionHandlers.getTools(),
        ...this.rapGeneratorHandlers.getTools(),
        {
          name: 'healthcheck',
          description: 'Check local MCP process health and configured target identity without contacting SAP',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        }
      ];
    const completeCatalog = [
      ...safeTools,
      ...safeDebugTools,
      ...completeControlledAdvancedTools,
      ...qualityTools,
      ...runtimeTools,
      ...focusedTools,
      ...legacyTools
    ];
    assertToolCatalogClassified(completeCatalog.map(tool => tool.name));
    return selectProfileTools(
      this.safetyPolicy.toolProfile,
      safeTools,
      legacyTools,
      runtimeTools,
      safeDebugTools,
      this.safetyPolicy.systemRole,
      controlledAdvancedTools,
      qualityTools,
      focusedTools
    ).map(withCanonicalToolMetadata);
  }

  private async dispatchTool(
    toolName: string,
    limitedArguments: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
        let result: unknown;
        // Operation policy and runtime catalog membership both protect direct calls.
        this.safetyPolicy.assertToolOperationAllowed(toolName);
        if (!this.toolCatalog.some(tool => tool.name === toolName)) {
          throw new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' is unavailable in the ${this.safetyPolicy.toolProfile} tool profile.`);
        }
        if (this.focusedTaskHandlers.supports(toolName)) {
          return this.focusedTaskHandlers.handle(toolName, limitedArguments);
        }
        if ((this.safetyPolicy.toolProfile === 'legacy-full'
          || this.safetyPolicy.toolProfile === 'development'
          || this.safetyPolicy.toolProfile === 'development-workbench'
          || this.safetyPolicy.toolProfile === 'diagnostic-readonly'
          || this.safetyPolicy.toolProfile === 'operations-readonly')
          && this.sm21Handlers?.supports(toolName)) {
          return this.sm21Handlers.handle(toolName, limitedArguments);
        }
        if (this.safetyPolicy.toolProfile !== 'safe' && this.highLevelReadHandlers.supports(toolName)) {
          return this.highLevelReadHandlers.handle(toolName, limitedArguments);
        }
        if (this.safeQualityHandlers.supports(toolName)) {
          return this.safeQualityHandlers.handle(toolName, limitedArguments);
        }
        if (this.repositoryObjectCreationHandlers.supports(toolName)) {
          return this.repositoryObjectCreationHandlers.handle(toolName, limitedArguments, signal);
        }
        if (this.safetyPolicy.toolProfile === 'diagnostic-readonly'
          && toolName !== 'inspectAbapObject'
          && !isReadOnlyLegacyTool(toolName)) {
          throw new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' is unavailable in the diagnostic-readonly tool profile.`);
        }
        if (this.safeAbapHandlers.supports(toolName)) {
          result = await this.safeAbapHandlers.handle(
            toolName,
            limitedArguments
          );
          return result;
        }
        if ((this.safetyPolicy.toolProfile === 'development' || this.safetyPolicy.toolProfile === 'development-workbench')
          && this.safeAdvancedHandlers.supports(toolName)) {
          return this.safeAdvancedHandlers.handle(toolName, limitedArguments);
        }
        if ((this.safetyPolicy.toolProfile === 'development' || this.safetyPolicy.toolProfile === 'development-workbench')
          && this.safeDebugHandlers.supports(toolName)) {
          return this.safeDebugHandlers.handle(toolName, limitedArguments);
        }
        if (this.safetyPolicy.toolProfile === 'safe') {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool '${toolName}' is unavailable in the safe tool profile.`
          );
        }

        if ((this.safetyPolicy.toolProfile === 'development' || this.safetyPolicy.toolProfile === 'development-workbench')
          && !isReadOnlyLegacyTool(toolName)) {
          throw new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' is unavailable in the ${this.safetyPolicy.toolProfile} tool profile.`);
        }

        switch (toolName) {
            case 'login':
            case 'logout':
            case 'dropSession':
                result = await this.authHandlers.handle(toolName, limitedArguments);
                break;
            case 'transportInfo':
            case 'createTransport':
            case 'hasTransportConfig':
            case 'transportConfigurations':
            case 'getTransportConfiguration':
            case 'setTransportsConfig':
            case 'createTransportsConfig':
            case 'userTransports':
            case 'transportsByConfig':
            case 'transportDelete':
            case 'transportRelease':
            case 'transportSetOwner':
            case 'transportAddUser':
            case 'systemUsers':
            case 'transportReference':
                result = await this.transportHandlers.handle(toolName, limitedArguments);
                break;
            case 'lock':
            case 'unLock':
                result = await this.objectLockHandlers.handle(toolName, limitedArguments);
                break;
            case 'objectStructure':
            case 'objectStructureElements':
            case 'searchObject':
            case 'findObjectPath':
            case 'objectTypes':
            case 'reentranceTicket':
                result = await this.objectHandlers.handle(toolName, limitedArguments);
                break;
            case 'classIncludes':
            case 'classComponents':
                result = await this.classHandlers.handle(toolName, limitedArguments);
                break;
            case 'syntaxCheckCode':
            case 'syntaxCheckCdsUrl':
            case 'codeCompletion':
            case 'findDefinition':
            case 'usageReferences':
            case 'syntaxCheckTypes':
            case 'codeCompletionFull':
            case 'runClass':
            case 'codeCompletionElement':
            case 'usageReferenceSnippets':
            case 'fixProposals':
            case 'fixEdits':
            case 'fragmentMappings':
            case 'abapDocumentation':
            case 'typeHierarchy':
            case 'objectEnhancements':
                result = await this.codeAnalysisHandlers.handle(toolName, limitedArguments);
                break;
            case 'getObjectSource':
            case 'setObjectSource':
                result = await this.objectSourceHandlers.handle(toolName, limitedArguments);
                break;
            case 'deleteObject':
                result = await this.objectDeletionHandlers.handle(toolName, limitedArguments);
                break;
            case 'activateObjects':
            case 'activateByName':
            case 'inactiveObjects':
                result = await this.objectManagementHandlers.handle(toolName, limitedArguments);
                break;
            case 'objectRegistrationInfo':
            case 'validateNewObject':
            case 'createObject':
                result = await this.objectRegistrationHandlers.handle(toolName, limitedArguments);
                break;
            case 'nodeContents':
            case 'mainPrograms':
                result = await this.nodeHandlers.handle(toolName, limitedArguments);
                break;
            case 'featureDetails':
            case 'collectionFeatureDetails':
            case 'findCollectionByUrl':
            case 'loadTypes':
            case 'adtDiscovery':
            case 'adtCoreDiscovery':
            case 'adtCompatibiliyGraph':
                result = await this.discoveryHandlers.handle(toolName, limitedArguments);
                break;
            case 'unitTestRun':
            case 'unitTestEvaluation':
            case 'unitTestOccurrenceMarkers':
            case 'createTestInclude':
                result = await this.unitTestHandlers.handle(toolName, limitedArguments);
                break;
            case 'prettyPrinterSetting':
            case 'setPrettyPrinterSetting':
            case 'prettyPrinter':
                result = await this.prettyPrinterHandlers.handle(toolName, limitedArguments);
                break;
            case 'gitRepos':
            case 'gitExternalRepoInfo':
            case 'gitCreateRepo':
            case 'gitPullRepo':
            case 'gitUnlinkRepo':
            case 'stageRepo':
            case 'pushRepo':
            case 'checkRepo':
            case 'remoteRepoInfo':
            case 'switchRepoBranch':
                result = await this.gitHandlers.handle(toolName, limitedArguments);
                break;
            case 'annotationDefinitions':
            case 'ddicElement':
            case 'ddicRepositoryAccess':
            case 'packageSearchHelp':
            case 'getDomainProperties':
            case 'setDomainProperties':
            case 'getDataElementProperties':
            case 'setDataElementProperties':
            case 'getTextElements':
            case 'setTextElements':
                result = await this.ddicHandlers.handle(toolName, limitedArguments);
                break;
            case 'publishServiceBinding':
            case 'unPublishServiceBinding':
            case 'bindingDetails':
                result = await this.serviceBindingHandlers.handle(toolName, limitedArguments);
                break;
            case 'tableContents':
            case 'runQuery':
                result = await this.queryHandlers.handle(toolName, limitedArguments);
                break;
            case 'feeds':
            case 'dumps':
                result = await this.feedHandlers.handle(toolName, limitedArguments);
                break;
            case 'debuggerListeners':
            case 'debuggerListen':
            case 'debuggerDeleteListener':
            case 'debuggerSetBreakpoints':
            case 'debuggerDeleteBreakpoints':
            case 'debuggerAttach':
            case 'debuggerSaveSettings':
            case 'debuggerStackTrace':
            case 'debuggerVariables':
            case 'debuggerChildVariables':
            case 'debuggerStep':
            case 'debuggerGoToStack':
            case 'debuggerSetVariableValue':
                result = await this.debugHandlers.handle(toolName, limitedArguments);
                break;
            case 'renameEvaluate':
            case 'renamePreview':
            case 'renameExecute':
                result = await this.renameHandlers.handle(toolName, limitedArguments);
                break;
            case 'atcCustomizing':
            case 'atcCheckVariant':
            case 'createAtcRun':
            case 'atcWorklists':
            case 'atcUsers':
            case 'atcExemptProposal':
            case 'atcRequestExemption':
            case 'isProposalMessage':
            case 'atcContactUri':
            case 'atcChangeContact':
            case 'atcDocumentation':
                result = await this.atcHandlers.handle(toolName, limitedArguments);
                break;
            case 'tracesList':
            case 'tracesListRequests':
            case 'tracesHitList':
            case 'tracesDbAccess':
            case 'tracesStatements':
            case 'tracesSetParameters':
            case 'tracesCreateConfiguration':
            case 'tracesDeleteConfiguration':
            case 'tracesDelete':
                result = await this.traceHandlers.handle(toolName, limitedArguments);
                break;
            case 'extractMethodEvaluate':
            case 'extractMethodPreview':
            case 'extractMethodExecute':
            case 'changePackagePreview':
            case 'changePackageExecute':
                result = await this.refactorHandlers.handle(toolName, limitedArguments);
                break;
            case 'rapGenValidateInitial':
            case 'rapGenGetSchema':
            case 'rapGenGetContent':
            case 'rapGenGetUiConfig':
            case 'rapGenValidateContent':
            case 'rapGenPreview':
            case 'rapGenGenerate':
            case 'rapGenIsAvailable':
            case 'rapGenPublishService':
                result = await this.rapGeneratorHandlers.handle(toolName, limitedArguments);
                break;
            case 'revisions':
                result = await this.revisionHandlers.handle(toolName, limitedArguments);
                break;
            case 'healthcheck':
                result = this.healthcheckResult();
                break;
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        }

        return result;
  }

  private healthcheckResult(): Record<string, unknown> {
    return {
      status: 'healthy',
      scope: 'mcp-process',
      sapConnectionVerified: false,
      configuredTarget: {
        host: this.safetyPolicy.systemHost,
        client: this.safetyPolicy.client,
        toolProfile: this.safetyPolicy.toolProfile,
        systemRole: this.safetyPolicy.systemRole
      },
      session: this.sessionSupervisor?.snapshot(),
      sessionRecovery: this.sessionResilience.sessionRecovery,
      statelessReads: this.sessionResilience.statelessReads,
      timestamp: new Date().toISOString()
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    console.error('MCP ABAP ADT API server running on stdio');
    if (this.safetyPolicy.toolProfile === 'legacy-full') {
      console.error('WARNING: SAP_MCP_TOOL_PROFILE=legacy-full exposes raw mutating and destructive ADT tools.');
    }
    
    // Handle shutdown
    process.on('SIGINT', async () => {
      await this.close();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      await this.close();
      process.exit(0);
    });
    
    // Handle errors
    this.onerror = (error) => {
      console.error('[MCP Error]', error);
    };
  }
}

function withCanonicalToolMetadata(tool: ToolDefinition): ToolDefinition {
  const operationClass = toolOperationClass(tool.name);
  if (!operationClass) throw new Error(`MCP tool '${tool.name}' has no operation policy classification.`);
  const local = operationClass === 'local';
  const readOnly = local || operationClass === 'read-only';
  const metadataClass = local ? 'local-only' : readOnly ? 'read-only tenant' : 'mutating tenant';
  return {
    ...tool,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly,
      openWorldHint: !local,
      ...tool.annotations
    },
    _meta: {
      operationClass: metadataClass,
      approvalRequired: false,
      ...tool._meta
    }
  };
}

export async function main(): Promise<void> {
  const password = await resolveSapPassword();
  const server = new AbapAdtServer(password);
  await server.run();
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  });
}
