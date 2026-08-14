import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  AdvancedOperationConfirmation,
  type AdvancedOperationConfirmationOptions,
  type AdvancedOperationStatusReader
} from '../safe/AdvancedOperationConfirmation.js';
import type { AdvancedOperationPreviewResult } from '../safe/advancedTypes.js';
import type { ToolDefinition, ToolSchemaProperty } from '../types/tools.js';

export interface SafeAdvancedWorkflowPort extends AdvancedOperationStatusReader {
  previewDdicPropertyChange(args: Record<string, unknown>): Promise<AdvancedOperationPreviewResult>;
  previewPackageChange(args: Record<string, unknown>): Promise<AdvancedOperationPreviewResult>;
  previewRapOperation(args: Record<string, unknown>): Promise<AdvancedOperationPreviewResult>;
}

const SAFE_ADVANCED_TOOL_NAMES = new Set([
  'previewDdicPropertyChange',
  'applyDdicPropertyChange',
  'previewPackageChange',
  'applyPackageChange',
  'previewRapOperation',
  'applyRapOperation'
]);

export class SafeAdvancedHandlers {
  private readonly confirmation: AdvancedOperationConfirmation;

  constructor(
    private readonly workflow: SafeAdvancedWorkflowPort,
    confirmationOptions: AdvancedOperationConfirmationOptions
  ) {
    this.confirmation = new AdvancedOperationConfirmation(workflow, confirmationOptions);
  }

  supports(toolName: string): boolean {
    return SAFE_ADVANCED_TOOL_NAMES.has(toolName);
  }

  getTools(): ToolDefinition[] {
    return [
      safeTool(
        'previewDdicPropertyChange',
        'Preview one bounded DEV domain, data element, or text element change without locking or writing SAP.',
        ddicPreviewSchema(),
        true,
        false
      ),
      safeTool(
        'applyDdicPropertyChange',
        'Open one native confirmation and apply the frozen DDIC plan with drift checks and bounded recovery.',
        planIdSchema(),
        false,
        true
      ),
      safeTool(
        'previewPackageChange',
        'Preview one bounded DEV object package migration without executing it.',
        packagePreviewSchema(),
        true,
        false
      ),
      safeTool(
        'applyPackageChange',
        'Open one native confirmation and execute the frozen package migration once after drift checks.',
        planIdSchema(),
        false,
        true
      ),
      safeTool(
        'previewRapOperation',
        'Validate and preview one bounded DEV RAP generation or service publication operation.',
        rapPreviewSchema(),
        true,
        false
      ),
      safeTool(
        'applyRapOperation',
        'Open one native confirmation and execute the frozen RAP generation or publication once.',
        planIdSchema(),
        false,
        true
      )
    ];
  }

  async handle(toolName: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'previewDdicPropertyChange':
        return this.renderPreview(await this.workflow.previewDdicPropertyChange(args));
      case 'applyDdicPropertyChange':
        return this.confirmation.confirmAndApply(String(args.operationPlanId || ''), 'DDIC');
      case 'previewPackageChange':
        return this.renderPreview(await this.workflow.previewPackageChange(args));
      case 'applyPackageChange':
        return this.confirmation.confirmAndApply(String(args.operationPlanId || ''), 'PACKAGE');
      case 'previewRapOperation':
        return this.renderPreview(await this.workflow.previewRapOperation(args));
      case 'applyRapOperation':
        return this.confirmation.confirmAndApply(String(args.operationPlanId || ''), 'RAP');
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown safe advanced tool: ${toolName}`);
    }
  }

  private renderPreview(preview: AdvancedOperationPreviewResult): Record<string, unknown> {
    const plan = preview.plan;
    const safePreview: AdvancedOperationPreviewResult = {
      status: 'preview',
      plan,
      confirmationRequired: true
    };
    return {
      content: [{
        type: 'text',
        text: [
          '## DEV 高级操作预览',
          '',
          `- 操作：${plan.operationKind}`,
          `- 目标：${plan.target.objectType} ${plan.target.objectName}`,
          `- 摘要：${plan.inputSummary.title}`,
          `- Transport：${plan.transport || '(none)'}`,
          `- 自动回滚：${plan.rollbackSupported ? '仅在结果明确时尝试一次受控恢复' : '不支持'}`,
          `- 计划：${plan.operationPlanId}`,
          `- 到期：${plan.expiresAt}`,
          '',
          '下一步调用对应的 apply 工具打开服务器原生确认；无需聊天文字确认。'
        ].join('\n')
      }],
      structuredContent: safePreview
    };
  }
}

function safeTool(
  name: string,
  description: string,
  inputSchema: ToolDefinition['inputSchema'],
  readOnlyHint: boolean,
  approvalRequired: boolean
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { ...inputSchema, additionalProperties: false },
    annotations: {
      readOnlyHint,
      destructiveHint: !readOnlyHint,
      idempotentHint: readOnlyHint,
      openWorldHint: true
    },
    _meta: { operationClass: readOnlyHint ? 'read-only tenant' : 'mutating tenant', approvalRequired }
  };
}

function planIdSchema(): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: {
      operationPlanId: { type: 'string', description: 'Server-managed advanced operation plan identifier', minLength: 1, maxLength: 128 }
    },
    required: ['operationPlanId']
  };
}

function ddicPreviewSchema(): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: {
      operation: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['SET_DOMAIN_PROPERTIES', 'SET_DATA_ELEMENT_PROPERTIES', 'SET_TEXT_ELEMENTS'] },
          objectName: { type: 'string', minLength: 1, maxLength: 255 },
          objectType: { type: 'string', enum: ['PROGRAM', 'CLASS', 'FUNCTION_GROUP'], optional: true },
          transportRequest: { type: 'string', minLength: 10, maxLength: 10 },
          properties: ddicPropertiesSchema(),
          metaData: ddicMetadataSchema(),
          category: { type: 'string', enum: ['symbols', 'selections', 'headings'], optional: true },
          elements: {
            type: 'array', maxItems: 500, optional: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', maxLength: 255 }, text: { type: 'string', maxLength: 8192 },
                maxLength: { type: 'number', minimum: 0, maximum: 100000, optional: true },
                ddicReference: { type: 'string', maxLength: 255, optional: true }
              },
              required: ['id', 'text']
            }
          }
        },
        required: ['kind', 'objectName', 'transportRequest']
      }
    },
    required: ['operation']
  };
}

function ddicPropertiesSchema(): ToolSchemaProperty {
  return {
    type: 'object', additionalProperties: false, optional: true,
    properties: {
      typeInformation: {
        type: 'object', additionalProperties: false, optional: true,
        properties: {
          datatype: { type: 'string', maxLength: 32 }, length: { type: 'number', minimum: 0, maximum: 100000 },
          decimals: { type: 'number', minimum: 0, maximum: 100 }
        }, required: ['datatype', 'length', 'decimals']
      },
      outputInformation: {
        type: 'object', additionalProperties: false, optional: true,
        properties: {
          length: { type: 'number', minimum: 0, maximum: 100000 }, style: { type: 'string', maxLength: 64, optional: true },
          conversionExit: { type: 'string', maxLength: 64, optional: true }, signExists: { type: 'boolean' },
          lowercase: { type: 'boolean' }, ampmFormat: { type: 'boolean' }
        }, required: ['length', 'signExists', 'lowercase', 'ampmFormat']
      },
      valueInformation: {
        type: 'object', additionalProperties: false, optional: true,
        properties: {
          valueTableRef: { type: 'string', maxLength: 255 }, appendExists: { type: 'boolean' },
          fixValues: {
            type: 'array', maxItems: 500, optional: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                low: { type: 'string', maxLength: 1024 }, high: { type: 'string', maxLength: 1024, optional: true },
                text: { type: 'string', maxLength: 2048, optional: true }
              }, required: ['low']
            }
          }
        }, required: ['valueTableRef', 'appendExists']
      },
      typeName: { type: 'string', maxLength: 255, optional: true },
      dataType: { type: 'string', maxLength: 32, optional: true },
      dataTypeLength: { type: 'number', minimum: 0, maximum: 100000, optional: true },
      dataTypeDecimals: { type: 'number', minimum: 0, maximum: 100, optional: true },
      fieldLabels: {
        type: 'object', additionalProperties: false, optional: true,
        properties: {
          shortFieldLabel: { type: 'string', maxLength: 255 }, mediumFieldLabel: { type: 'string', maxLength: 255 },
          longFieldLabel: { type: 'string', maxLength: 255 }, headingFieldLabel: { type: 'string', maxLength: 255 }
        }, required: ['shortFieldLabel', 'mediumFieldLabel', 'longFieldLabel', 'headingFieldLabel']
      },
      searchHelp: { type: 'string', maxLength: 255, optional: true },
      searchHelpParameter: { type: 'string', maxLength: 255, optional: true },
      setGetParameter: { type: 'string', maxLength: 255, optional: true },
      defaultComponentName: { type: 'string', maxLength: 255, optional: true },
      deactivateInputHistory: { type: 'boolean', optional: true }, changeDocument: { type: 'boolean', optional: true },
      leftToRightDirection: { type: 'boolean', optional: true }, deactivateBIDIFiltering: { type: 'boolean', optional: true }
    }
  };
}

function ddicMetadataSchema(): ToolSchemaProperty {
  return {
    type: 'object', additionalProperties: false, optional: true,
    properties: {
      name: { type: 'string', maxLength: 255 }, description: { type: 'string', maxLength: 255 },
      language: { type: 'string', maxLength: 10 }, masterLanguage: { type: 'string', maxLength: 10 },
      masterSystem: { type: 'string', maxLength: 32 }, responsible: { type: 'string', maxLength: 64 },
      packageName: { type: 'string', maxLength: 255 }, packageDescription: { type: 'string', maxLength: 255, optional: true },
      packageUri: { type: 'string', maxLength: 2048, optional: true }
    },
    required: ['name', 'description', 'language', 'masterLanguage', 'masterSystem', 'responsible', 'packageName']
  };
}

function packagePreviewSchema(): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: {
      objectType: { type: 'string', enum: ['PROGRAM', 'INCLUDE', 'CLASS', 'FUNCTION_MODULE'] },
      objectName: { type: 'string', minLength: 1, maxLength: 255 },
      oldPackage: { type: 'string', minLength: 1, maxLength: 255 },
      newPackage: { type: 'string', minLength: 1, maxLength: 255 },
      transportRequest: { type: 'string', minLength: 10, maxLength: 10 }
    },
    required: ['objectType', 'objectName', 'oldPackage', 'newPackage', 'transportRequest']
  };
}

function rapPreviewSchema(): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: {
      operation: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['RAP_GENERATE', 'RAP_PUBLISH_SERVICE'] },
          genId: { type: 'string', enum: ['uiservice', 'webapiservice'], optional: true },
          referenceObjectName: { type: 'string', maxLength: 255, optional: true },
          packageName: { type: 'string', maxLength: 255, optional: true },
          transportRequest: { type: 'string', minLength: 10, maxLength: 10, optional: true },
          serviceBindingName: { type: 'string', maxLength: 255, optional: true },
          content: rapContentSchema()
        },
        required: ['kind']
      }
    },
    required: ['operation']
  };
}

function rapContentSchema(): ToolSchemaProperty {
  return {
    type: 'object', additionalProperties: false, optional: true,
    properties: {
      metadata: {
        type: 'object', additionalProperties: false, optional: true,
        properties: { package: { type: 'string', maxLength: 255 }, masterLanguage: { type: 'string', maxLength: 10, optional: true } },
        required: ['package']
      },
      general: {
        type: 'object', additionalProperties: false,
        properties: { referenceObjectName: { type: 'string', maxLength: 255, optional: true }, description: { type: 'string', maxLength: 255 } },
        required: ['description']
      },
      businessObject: {
        type: 'object', additionalProperties: false,
        properties: {
          dataModelEntity: {
            type: 'object', additionalProperties: false,
            properties: { cdsName: { type: 'string', maxLength: 255 }, entityName: { type: 'string', maxLength: 255, optional: true } },
            required: ['cdsName']
          },
          behavior: {
            type: 'object', additionalProperties: false,
            properties: {
              implementationType: { type: 'string', maxLength: 64 }, implementationClass: { type: 'string', maxLength: 255 },
              draftTable: { type: 'string', maxLength: 255 }
            }, required: ['implementationType', 'implementationClass', 'draftTable']
          }
        }, required: ['dataModelEntity', 'behavior']
      },
      serviceProjection: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string', maxLength: 255 } }, required: ['name']
      },
      businessService: {
        type: 'object', additionalProperties: false,
        properties: {
          serviceDefinition: {
            type: 'object', additionalProperties: false,
            properties: { name: { type: 'string', maxLength: 255 } }, required: ['name']
          },
          serviceBinding: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', maxLength: 255 },
              bindingType: { type: 'string', enum: ['OData V2 - UI', 'OData V2 - Web API', 'OData V4 - UI', 'OData V4 - Web API'] }
            }, required: ['name', 'bindingType']
          }
        }, required: ['serviceDefinition', 'serviceBinding']
      }
    },
    required: ['general', 'businessObject', 'serviceProjection', 'businessService']
  };
}
