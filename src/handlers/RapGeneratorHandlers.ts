import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolSchemaProperty } from '../types/tools.js';
import { BaseHandler } from './BaseHandler.js';
import { mutatingRawTool, readOnlyRawTool } from './rawToolMetadata.js';

const generatorProperties: Record<string, ToolSchemaProperty> = {
  genId: { type: 'string', description: 'RAP generator ID', enum: ['uiservice', 'webapiservice'] },
  refObjectUri: { type: 'string', description: 'Exact referenced object ADT URI', maxLength: 2048 },
  packageName: { type: 'string', description: 'Target package name', maxLength: 255 }
};

export class RapGeneratorHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      readOnlyRawTool('rapGenValidateInitial', 'Validate RAP generator package, reference object, and authorization without creating objects.', {
        type: 'object',
        properties: {
          ...generatorProperties,
          checks: { type: 'array', description: 'Bounded generator check names', maxItems: 16, optional: true, items: { type: 'string', maxLength: 64 } }
        },
        required: ['genId', 'refObjectUri', 'packageName']
      }),
      readOnlyRawTool('rapGenGetSchema', 'Read the RAP generator JSON schema.', generatorPackageSchema()),
      readOnlyRawTool('rapGenGetContent', 'Read prefilled RAP generator content.', generatorPackageSchema()),
      readOnlyRawTool('rapGenGetUiConfig', 'Read the RAP generator UI configuration.', generatorPackageSchema()),
      readOnlyRawTool('rapGenValidateContent', 'Validate bounded RAP generator content without generating objects.', generatorContentSchema()),
      readOnlyRawTool('rapGenPreview', 'Preview the bounded set of RAP objects that would be generated; no objects are created.', generatorContentSchema()),
      readOnlyRawTool('rapGenIsAvailable', 'Check whether a RAP generator endpoint is available.', {
        type: 'object',
        properties: { genId: { ...generatorProperties.genId, optional: true } }
      }),
      mutatingRawTool('rapGenGenerate', 'High risk raw RAP generation. Creates all previewed objects without automatic deletion or retry.', {
        ...generatorContentSchema(),
        properties: {
          ...generatorContentSchema().properties,
          transport: { type: 'string', description: 'Transport request or empty for a local package', maxLength: 64 }
        },
        required: ['genId', 'refObjectUri', 'transport', 'content']
      }),
      mutatingRawTool('rapGenPublishService', 'High risk raw RAP service publication. Does not automatically unpublish or retry.', {
        type: 'object',
        properties: { srvbName: { type: 'string', description: 'Exact service binding name', minLength: 1, maxLength: 255 } },
        required: ['srvbName']
      })
    ];
  }

  async handle(toolName: string, args: Record<string, any>): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'rapGenValidateInitial':
        return this.executeClientCall('RAP initial validation', () => this.adtclient.rapGenValidateInitial(args.genId, args.refObjectUri, args.packageName, args.checks));
      case 'rapGenGetSchema':
        return this.executeClientCall('RAP schema read', () => this.adtclient.rapGenGetSchema(args.genId, args.refObjectUri, args.packageName));
      case 'rapGenGetContent':
        return this.executeClientCall('RAP content read', () => this.adtclient.rapGenGetContent(args.genId, args.refObjectUri, args.packageName));
      case 'rapGenGetUiConfig':
        return this.executeClientCall('RAP UI configuration read', () => this.adtclient.rapGenGetUiConfig(args.genId, args.refObjectUri, args.packageName));
      case 'rapGenValidateContent':
        return this.executeClientCall('RAP content validation', () => this.adtclient.rapGenValidateContent(args.genId, args.refObjectUri, args.content));
      case 'rapGenPreview':
        return this.executeClientCall('RAP generation preview', () => this.adtclient.rapGenPreview(args.genId, args.refObjectUri, args.content));
      case 'rapGenIsAvailable':
        return this.executeClientCall('RAP availability check', () => this.adtclient.rapGenIsAvailable(args.genId));
      case 'rapGenGenerate':
        return this.executeClientCall('RAP generation', () => this.adtclient.rapGenGenerate(args.genId, args.refObjectUri, args.transport, args.content));
      case 'rapGenPublishService':
        return this.executeClientCall('RAP service publication', () => this.adtclient.rapGenPublishService(args.srvbName));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown RAP generator tool: ${toolName}`);
    }
  }
}

function generatorPackageSchema(): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: { ...generatorProperties },
    required: ['genId', 'refObjectUri', 'packageName']
  };
}

function generatorContentSchema(): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: {
      genId: generatorProperties.genId,
      refObjectUri: generatorProperties.refObjectUri,
      content: rapContentProperty()
    },
    required: ['genId', 'refObjectUri', 'content']
  };
}

function rapContentProperty(): ToolSchemaProperty {
  return {
    type: 'object',
    description: 'Bounded RAP generator content matching the selected generator schema',
    additionalProperties: false,
    maxProperties: 5,
    properties: {
      metadata: {
        type: 'object', additionalProperties: false, optional: true,
        properties: {
          package: { type: 'string', maxLength: 255 },
          masterLanguage: { type: 'string', maxLength: 10, optional: true }
        }, required: ['package']
      },
      general: {
        type: 'object', additionalProperties: false,
        properties: {
          referenceObjectName: { type: 'string', maxLength: 255, optional: true },
          description: { type: 'string', maxLength: 255 }
        }, required: ['description']
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
