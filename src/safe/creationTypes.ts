import type {
  NewObjectOptions,
  ValidateOptions,
  ValidationResult
} from '../adt/index.js';
import type { TransportValidationSummary } from './TransportRegistration.js';
import type {
  ChangeStageResult,
  ConfirmationMode,
  SafeAdtClient,
  SourceMatchType
} from './types.js';

export type CreationObjectType = 'PROGRAM' | 'FUNCTION_GROUP' | 'FUNCTION_MODULE' | 'FUNCTION_GROUP_INCLUDE';

export interface CreationObjectInput {
  objectType: CreationObjectType | string;
  objectName: string;
  description: string;
  packageName?: string;
  parentFunctionGroup?: string;
  source?: string;
  /** Three-character suffix for a generated function-group include. */
  creationName?: string;
}

export interface PreviewCreationInput {
  objects: CreationObjectInput[];
  transportRequest: string;
}

export interface ApplyCreationInput {
  creationPlanId: string;
  confirmedByUser: boolean;
  confirmationMode: ConfirmationMode;
}

export interface ResolvedCreationObject {
  objectType: CreationObjectType;
  objectName: string;
  description: string;
  adtType: 'PROG/P' | 'FUGR/F' | 'FUGR/FF' | 'FUGR/I';
  packageName: string;
  parentName: string;
  parentPath: string;
  /**
   * resolve 阶段搜索返回并经校验的父对象（包/函数组）ADT URI。7.51 兼容
   * 改造：软检查优先用它替代自拼 parentPath，排除"拼出 URI 与系统实际
   * 可映射形态不同"的变量；缺失时回退 parentPath。
   */
  parentUri?: string;
  parentFunctionGroup?: string;
  objectUrl: string;
  sourceUrl?: string;
  activationParentUrl?: string;
  source?: string;
  sourceHash?: string;
  creationName?: string;
}

export interface CreatedObjectRecord extends ResolvedCreationObject {
  actualObjectUrl: string;
  actualSourceUrl?: string;
  ownershipProven: boolean;
  /**
   * 创建后归属证明结论（7.51 兼容改造）：PROVEN/PROVEN_VIA_GROUP = 已证明
   * 登记进指定请求；UNPROVEN = 读取成功但请求内无该对象的登记条目；
   * UNKNOWN = 证明通道全部不可用。两种未证明态都禁止自动补偿删除。
   */
  transportRegistration?: 'PROVEN' | 'PROVEN_VIA_GROUP' | 'UNPROVEN' | 'UNKNOWN';
  unlockSucceeded?: boolean;
  verifiedSourceHash?: string;
  sourceMatchType?: SourceMatchType;
  compensationAttempted?: boolean;
  compensationSucceeded?: boolean;
}

export type CreationPlanStatus =
  | 'PREVIEWED'
  | 'APPLYING'
  | 'APPLIED'
  | 'COMPENSATED'
  | 'COMPENSATION_FAILED'
  | 'FAILED'
  | 'EXPIRED';

export interface CreationPlan {
  creationPlanId: string;
  createdAt: number;
  expiresAt: number;
  terminalAt?: number;
  status: CreationPlanStatus;
  systemHost: string;
  client: string;
  transportRequest: string;
  /** 传输门禁与软检查摘要（preview 时生成，apply 重验后刷新）。 */
  transportValidation?: TransportValidationSummary;
  objects: ResolvedCreationObject[];
  stages: ChangeStageResult[];
  createdObjects: CreatedObjectRecord[];
  primaryError?: {
    code: string;
    stage: string;
    message: string;
    details?: Record<string, unknown>;
  };
  confirmationMode?: ConfirmationMode;
  compensationAttempted?: boolean;
  compensationSucceeded?: boolean;
}

export interface CreationObjectView {
  objectType: CreationObjectType;
  objectName: string;
  description: string;
  packageName: string;
  parentFunctionGroup?: string;
  objectUrl: string;
  sourceHash?: string;
}

export interface CreationPlanView {
  creationPlanId: string;
  createdAt: string;
  expiresAt: string;
  status: CreationPlanStatus;
  systemHost: string;
  client: string;
  transportRequest: string;
  transportValidation?: TransportValidationSummary;
  objects: CreationObjectView[];
  stages: ChangeStageResult[];
  createdObjects: Array<{
    objectType: CreationObjectType;
    objectName: string;
    actualObjectUrl: string;
    ownershipProven: boolean;
    transportRegistration?: 'PROVEN' | 'PROVEN_VIA_GROUP' | 'UNPROVEN' | 'UNKNOWN';
    unlockSucceeded?: boolean;
    verifiedSourceHash?: string;
    sourceMatchType?: SourceMatchType;
    compensationAttempted?: boolean;
    compensationSucceeded?: boolean;
  }>;
  primaryError?: CreationPlan['primaryError'];
  confirmationMode?: ConfirmationMode;
  compensationAttempted?: boolean;
  compensationSucceeded?: boolean;
}

export interface CreationAdtClient extends SafeAdtClient {
  validateNewObject(options: ValidateOptions): Promise<ValidationResult>;
  createObject(options: NewObjectOptions): Promise<void>;
  deleteObject(objectUrl: string, lockHandle: string, transport?: string): Promise<void>;
  /**
   * 只读自由 SQL 通道（datapreview；与 TransportHistoryApi 同款）。7.51 兼容
   * 改造的可选能力：ADT 传输资源无法映射 URI 时，E070/E071 只读查询作为
   * 请求门禁与归属证明的兜底通道。缺失时相关降级路径按"通道不可用"处理。
   */
  runQuery?(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>;
}
