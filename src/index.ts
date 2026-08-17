#!/usr/bin/env node

import { config } from 'dotenv';
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
  private safetyPolicy: SafetyPolicy;
  private readonly guardrails: RuntimeGuardrailValues;
  private readonly executionGate: ToolExecutionGate;
  private toolCatalog: ToolDefinition[] = [];
  private safeAbapHandlers: SafeAbapHandlers;
  private safeDebugHandlers: SafeDebugHandlers;
  private safeAdvancedHandlers: SafeAdvancedHandlers;
  private safeQualityHandlers: SafeQualityHandlers;
  private highLevelReadHandlers: HighLevelReadHandlers;
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

    constructor() {
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
    configureLogLevel(this.guardrails.logLevel);
    this.executionGate = new ToolExecutionGate(this.guardrails.maxConcurrentTools, this.guardrails.maxQueuedTools);
    sourceCache.configure({
      maxEntries: this.guardrails.sourceCacheMaxEntries,
      maxItemBytes: this.guardrails.sourceCacheMaxItemBytes,
      ttlMs: this.guardrails.sourceCacheTtlMs
    });
    const missingVars = ['SAP_URL', 'SAP_USER', 'SAP_PASSWORD'].filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
    
    this.adtClient = new ADTClient(
      process.env.SAP_URL as string,
      process.env.SAP_USER as string,
      process.env.SAP_PASSWORD as string,
      process.env.SAP_CLIENT as string,
      process.env.SAP_LANGUAGE as string,
      adtClientOptions(this.guardrails)
    );
    this.adtClient.stateful = session_types.stateful
    this.safetyPolicy = SafetyPolicy.fromEnvironment();
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
    const objectResolver = new AbapObjectResolver(this.adtClient);
    this.highLevelReadHandlers = new HighLevelReadHandlers(
      new RuntimeDumpReader(this.adtClient),
      new ClassicTableInspector(this.adtClient),
      new SystemInspector(this.adtClient, {
        host: this.safetyPolicy.systemHost,
        client: this.safetyPolicy.client,
        toolProfile: this.safetyPolicy.toolProfile,
        systemRole: this.safetyPolicy.systemRole
      }),
      new AbapMemberSourceReader(this.adtClient, objectResolver)
    );
    // SM21 reuses the authenticated ADT HTTP client; the custom SICF service remains read-only.
    this.sm21Handlers = new Sm21Handlers(new AdtHttpSm21Client(this.adtClient.httpClient), sm21Config, this.adtClient);
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

    this.setRequestHandler(CallToolRequestSchema, async (request) => {
      return executeGuardedToolCall(
        request.params.name,
        (request.params.arguments || {}) as Record<string, unknown>,
        this.guardrails,
        this.executionGate,
        usesSapExecutionGate(request.params.name),
        limitedArguments => this.dispatchTool(request.params.name, limitedArguments),
        result => this.serializeResult(result),
        error => this.handleError(error)
      );
    });
  }

  private createToolCatalog(): ToolDefinition[] {
    const safeTools = this.safeAbapHandlers.getTools();
    const safeDebugTools = this.safeDebugHandlers.getTools();
    const controlledAdvancedTools = this.safeAdvancedHandlers.getTools();
    const qualityTools = this.safeQualityHandlers.getTools();
    const sm21Tools = this.sm21Handlers?.getTools() || [];
    const runtimeTools = [...this.highLevelReadHandlers.getTools(), ...sm21Tools];
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
      ...controlledAdvancedTools,
      ...qualityTools,
      ...runtimeTools,
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
      qualityTools
    ).map(withCanonicalToolMetadata);
  }

  private async dispatchTool(toolName: string, limitedArguments: Record<string, unknown>): Promise<unknown> {
        let result: unknown;
        // Operation policy and runtime catalog membership both protect direct calls.
        this.safetyPolicy.assertToolOperationAllowed(toolName);
        if (!this.toolCatalog.some(tool => tool.name === toolName)) {
          throw new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' is unavailable in the ${this.safetyPolicy.toolProfile} tool profile.`);
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
                result = {
                  status: 'healthy',
                  scope: 'mcp-process',
                  sapConnectionVerified: false,
                  configuredTarget: {
                    host: this.safetyPolicy.systemHost,
                    client: this.safetyPolicy.client,
                    toolProfile: this.safetyPolicy.toolProfile,
                    systemRole: this.safetyPolicy.systemRole
                  },
                  timestamp: new Date().toISOString()
                };
                break;
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        }

        return result;
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
  const server = new AbapAdtServer();
  await server.run();
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  });
}
