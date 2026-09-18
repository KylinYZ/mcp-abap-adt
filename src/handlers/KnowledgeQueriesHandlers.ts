import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../types/tools.js';
import type { KnowledgeQueriesClient } from '../adt/KnowledgeQueriesApi.js';

/**
 * ============================================================================
 * 知识查询只读三工具 MCP 处理器（diagnostics.knowledge-queries 行：
 * documentation + img_search + img_activity 子集）
 * ============================================================================
 *
 * 暴露三个只读工具（数据源为 SAP 文档/IMG 表的自由 SQL SELECT）：
 *   - getAbapDocumentation：ABAP 文档正文或索引（DOKIL/DOKTL）
 *   - searchImgActivities：IMG 自定义活动与文件夹文本检索（CUS_IMGACT/
 *     CUS_IMGACH/TNODEIMGT）
 *   - getImgActivity：单个 IMG 活动完整详情——基础/文本/菜单路径递归
 *     （TNODEIMGR 引用 → TNODEIMG 向上走链 + TNODEIMGT 文本）/HY 文档
 *
 * 业务规则：
 *   - 只读工具（readOnlyHint=true、destructiveHint=false、approvalRequired=false；
 *     _meta.operationClass='read-only tenant'）。
 *   - 边界（notes 随结果返回）：fm_test_data、cluster_read（S/2 集群读取）
 *     不在本子集内（独立子系统）。
 *   - 文本入参处理器层做长度预检，API 层引号转义 + 控制字符拒绝（纵深防御）。
 *   - "不存在"类错误按 InvalidParams 透出；底层异常统一脱敏为 InternalError。
 */

/** 与 CrossReferenceHandlers 一致的只读工具定义强类型。 */
type KnowledgeToolDefinition = ToolDefinition & {
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: true;
  };
  _meta: {
    operationClass: 'read-only tenant';
    approvalRequired: false;
  };
};

/** 本处理器认领的工具名。 */
const KNOWLEDGE_TOOL_NAMES = new Set(['getAbapDocumentation', 'searchImgActivities', 'getImgActivity']);

export class KnowledgeQueriesHandlers {
  /**
   * @param knowledgeQueries 知识查询只读客户端（集成时用
   *   src/adt/KnowledgeQueriesApi.ts 的 createKnowledgeQueriesClient(readClient) 构造）
   */
  constructor(private readonly knowledgeQueries: KnowledgeQueriesClient) {}

  /** 该工具名是否由本处理器负责。 */
  supports(toolName: string): boolean {
    return KNOWLEDGE_TOOL_NAMES.has(toolName);
  }

  /** 两个只读工具定义。 */
  getTools(): KnowledgeToolDefinition[] {
    const readOnly: Pick<KnowledgeToolDefinition, 'annotations' | '_meta'> = {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      _meta: { operationClass: 'read-only tenant', approvalRequired: false }
    };
    return [
      {
        name: 'getAbapDocumentation',
        description:
          'Read ABAP documentation (SE61-style) for an object: the content lines of the latest version in a given language (mode=content, default), or the index of all documented classes/languages for that object (mode=index). Data source: DOKIL/DOKTL via read-only SQL. Read-only.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            docClass: {
              type: 'string',
              description: 'Documentation class (DOKIL.ID): DE=data element, RE=report, FU=function module, CL=class, TX=general text, etc.',
              minLength: 1,
              maxLength: 4
            },
            docObject: {
              type: 'string',
              description: 'Documentation object name (e.g. the data element or program name).',
              minLength: 1,
              maxLength: 40
            },
            language: {
              type: 'string',
              description: 'SAP language key (1-2 letters, default EN).',
              optional: true
            },
            mode: {
              type: 'string',
              enum: ['content', 'index'],
              description: 'content = read the latest version lines (default); index = list all documented classes/languages.',
              optional: true
            },
            maxLines: {
              type: 'number',
              description: 'Maximum content lines to return; default 500, cap 2000. Longer documents are truncated with a note.',
              minimum: 1,
              maximum: 2000,
              optional: true
            }
          },
          required: ['docClass', 'docObject']
        },
        ...readOnly
      },
      {
        name: 'searchImgActivities',
        description:
          'Search SAP IMG (customizing) activities and folder nodes by title text: activities come from CUS_IMGACT with their transaction codes (CUS_IMGACH), folders from TNODEIMGT. * wildcards allowed; a plain word is searched as %word%. Read-only.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: {
              type: 'string',
              description: "A word or pattern (* wildcard) from the node's title.",
              minLength: 1,
              maxLength: 60
            },
            language: {
              type: 'string',
              description: 'SAP language key (1-2 letters, default EN).',
              optional: true
            },
            limit: {
              type: 'number',
              description: 'Maximum nodes to return; default 40, cap 100.',
              minimum: 1,
              maximum: 100,
              optional: true
            }
          },
          required: ['text']
        },
        ...readOnly
      },
      {
        name: 'getImgActivity',
        description:
          'Read the full detail of one SAP IMG (customizing) activity: base row (CUS_IMGACH), its description text in a language (CUS_IMGACT), the IMG menu paths to it (TNODEIMGR references walked up through TNODEIMG with TNODEIMGT texts), and its HY documentation when present. Auxiliary pieces degrade to notes instead of failing the read. Read-only.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            activity: {
              type: 'string',
              description: "The activity's technical name from img_search (CUS_IMGACH.ACTIVITY), e.g. APOC_C_FORMV.",
              minLength: 1,
              maxLength: 40
            },
            language: {
              type: 'string',
              description: 'SAP language key (1-2 letters, default EN).',
              optional: true
            },
            maxRefs: {
              type: 'number',
              description: 'Maximum IMG reference nodes to expand into paths (each costs a few queries; the datapreview channel has a per-session budget). Default 20.',
              minimum: 1,
              maximum: 20,
              optional: true
            }
          },
          required: ['activity']
        },
        ...readOnly
      }
    ];
  }

  /**
   * 分派到注入的只读客户端。MCP 语义错误透传；底层异常脱敏为 InternalError。
   */
  async handle(toolName: string, argumentsValue: Record<string, unknown> = {}): Promise<Record<string, any>> {
    try {
      if (toolName === 'getAbapDocumentation') {
        const docClass = typeof argumentsValue?.docClass === 'string' ? argumentsValue.docClass.trim().toUpperCase() : '';
        if (!docClass || docClass.length > 4 || !/^[A-Z0-9_/]+$/.test(docClass)) {
          throw invalid(`${toolName} requires docClass: a documentation class of at most 4 characters (e.g. DE, RE, TX).`);
        }
        const docObject = typeof argumentsValue?.docObject === 'string' ? argumentsValue.docObject.trim().toUpperCase() : '';
        if (!docObject || docObject.length > 40 || !/^[A-Z0-9_/$]+$/.test(docObject)) {
          throw invalid(
            `${toolName} requires docObject: a non-empty documentation object name of at most 40`
            + ' characters matching [A-Z0-9_/$].'
          );
        }
        const language = this.language(toolName, argumentsValue);
        const mode = argumentsValue?.mode;
        if (mode !== undefined && mode !== 'content' && mode !== 'index') {
          throw invalid(`${toolName} requires mode to be "content" or "index".`);
        }
        const maxLines = this.boundedNumber(toolName, argumentsValue.maxLines, 'maxLines', 1, 2000);
        return success(await this.knowledgeQueries.getAbapDocumentation({
          docClass,
          docObject,
          language,
          ...(mode !== undefined ? { mode } : {}),
          ...(maxLines !== undefined ? { maxLines } : {})
        }));
      }
      if (toolName === 'searchImgActivities') {
        const text = typeof argumentsValue?.text === 'string' ? argumentsValue.text.trim() : '';
        if (!text || text.length > 60) {
          throw invalid(`${toolName} requires text: a search word or * pattern of at most 60 characters.`);
        }
        const language = this.language(toolName, argumentsValue);
        const limit = this.boundedNumber(toolName, argumentsValue.limit, 'limit', 1, 100);
        return success(await this.knowledgeQueries.searchImgActivities({
          text,
          language,
          ...(limit !== undefined ? { limit } : {})
        }));
      }
      if (toolName === 'getImgActivity') {
        const activity = typeof argumentsValue?.activity === 'string' ? argumentsValue.activity.trim().toUpperCase() : '';
        if (!activity || activity.length > 40 || !/^[A-Z0-9_/]+$/.test(activity)) {
          throw invalid(
            `${toolName} requires activity: the technical name of an IMG activity of at most 40`
            + ' characters matching [A-Z0-9_/].'
          );
        }
        const language = this.language(toolName, argumentsValue);
        const maxRefs = this.boundedNumber(toolName, argumentsValue.maxRefs, 'maxRefs', 1, 20);
        return success(await this.knowledgeQueries.getImgActivity({ activity, language, ...(maxRefs !== undefined ? { maxRefs } : {}) }));
      }
      throw new McpError(ErrorCode.MethodNotFound, `Unknown knowledge-queries tool: ${toolName}`);
    } catch (error) {
      if (error instanceof McpError) throw error;
      // "不存在"类错误对调用方有排查价值，按 InvalidParams 透出；其余脱敏。
      const message = error instanceof Error ? error.message : String(error);
      if (/documentation for .* in language/.test(message) || /IMG activity .* does not exist/.test(message)) {
        throw new McpError(ErrorCode.InvalidParams, message);
      }
      throw new McpError(ErrorCode.InternalError, `${toolName} failed.`);
    }
  }

  /** 语言键校验：1-2 位字母（API 层同口径复检）。 */
  private language(toolName: string, argumentsValue: Record<string, unknown>): string {
    const raw = typeof argumentsValue?.language === 'string' ? argumentsValue.language.trim() : '';
    if (raw !== '' && !/^[A-Za-z]{1,2}$/.test(raw)) {
      throw invalid(`${toolName} requires language to be a 1-2 letter SAP language key.`);
    }
    return raw === '' ? 'EN' : raw.toUpperCase();
  }

  /** 可选有界数字：undefined 透传；非法类型拒绝；越界收敛。 */
  private boundedNumber(
    toolName: string,
    value: unknown,
    label: string,
    min: number,
    max: number
  ): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalid(`${toolName} requires ${label} to be a finite number.`);
    }
    return Math.min(Math.max(Math.floor(value), min), max);
  }
}

/** 参数校验失败的 MCP 语义错误。 */
function invalid(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message);
}

/** 成功响应包装：content 文本与 structuredContent 同构。 */
function success(result: unknown): Record<string, any> {
  const structuredContent = { status: 'success', result };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}
