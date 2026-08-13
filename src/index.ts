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
import { ADTClient, session_types } from "abap-adt-api";
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
import { Sm21Handlers } from './handlers/Sm21Handlers.js';
import { SafeAbapHandlers, selectProfileTools } from './handlers/SafeAbapHandlers.js';
import { AbapChangeWorkflow } from './safe/AbapChangeWorkflow.js';
import { AbapCreationResolver } from './safe/AbapCreationResolver.js';
import { AbapObjectCreationWorkflow } from './safe/AbapObjectCreationWorkflow.js';
import { AbapObjectResolver } from './safe/AbapObjectResolver.js';
import { AuditLogger } from './safe/AuditLogger.js';
import { ChangePlanStore } from './safe/ChangePlanStore.js';
import { CreationPlanStore } from './safe/CreationPlanStore.js';
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

config({ path: path.resolve(__dirname, '../.env') });

export class AbapAdtServer extends Server {
  private adtClient: ADTClient;
  private safetyPolicy: SafetyPolicy;
  private readonly guardrails: RuntimeGuardrailValues;
  private readonly executionGate: ToolExecutionGate;
  private toolCatalog: ToolDefinition[] = [];
  private safeAbapHandlers: SafeAbapHandlers;
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
    private sm21Handlers?: Sm21Handlers;

    constructor() {
    super(
      {
        name: "mcp-abap-abap-adt-api",
        version: "0.1.1",
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
    // SM21 reuses the authenticated ADT HTTP client; the custom SICF service remains read-only.
    this.sm21Handlers = new Sm21Handlers(new AdtHttpSm21Client(this.adtClient.httpClient), sm21Config, this.adtClient);
    const objectResolver = new AbapObjectResolver(this.adtClient);
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
    const sm21Tools = this.sm21Handlers?.getTools() || [];
    const legacyTools = this.safetyPolicy.toolProfile === 'legacy-full' ? [
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
        {
          name: 'healthcheck',
          description: 'Check server health and connectivity',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        }
      ] : [];
    // Safe mode exposes only audited high-level source-change and object-creation workflows.
    return selectProfileTools(this.safetyPolicy.toolProfile, safeTools, [...sm21Tools, ...legacyTools]);
  }

  private async dispatchTool(toolName: string, limitedArguments: Record<string, unknown>): Promise<unknown> {
        let result: unknown;
        if (this.safetyPolicy.toolProfile === 'legacy-full' && this.sm21Handlers?.supports(toolName)) {
          return this.sm21Handlers.handle(toolName, limitedArguments);
        }
        if (this.safeAbapHandlers.supports(toolName)) {
          result = await this.safeAbapHandlers.handle(
            toolName,
            limitedArguments
          );
          return result;
        }
        if (this.safetyPolicy.toolProfile === 'safe') {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool '${toolName}' is unavailable in the safe tool profile.`
          );
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
                result = await this.refactorHandlers.handle(toolName, limitedArguments);
                break;
            case 'revisions':
                result = await this.revisionHandlers.handle(toolName, limitedArguments);
                break;
            case 'healthcheck':
                result = { status: 'healthy', timestamp: new Date().toISOString() };
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
