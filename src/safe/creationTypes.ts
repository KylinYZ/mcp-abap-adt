import type {
  NewObjectOptions,
  ValidateOptions,
  ValidationResult
} from 'abap-adt-api';
import type {
  ChangeStageResult,
  ConfirmationMode,
  SafeAdtClient,
  SourceMatchType
} from './types.js';

export type CreationObjectType = 'PROGRAM' | 'FUNCTION_GROUP' | 'FUNCTION_MODULE';

export interface CreationObjectInput {
  objectType: CreationObjectType | string;
  objectName: string;
  description: string;
  packageName?: string;
  parentFunctionGroup?: string;
  source?: string;
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
  adtType: 'PROG/P' | 'FUGR/F' | 'FUGR/FF';
  packageName: string;
  parentName: string;
  parentPath: string;
  parentFunctionGroup?: string;
  objectUrl: string;
  sourceUrl?: string;
  activationParentUrl?: string;
  source?: string;
  sourceHash?: string;
}

export interface CreatedObjectRecord extends ResolvedCreationObject {
  actualObjectUrl: string;
  actualSourceUrl?: string;
  ownershipProven: boolean;
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
  objects: ResolvedCreationObject[];
  stages: ChangeStageResult[];
  createdObjects: CreatedObjectRecord[];
  primaryError?: {
    code: string;
    stage: string;
    message: string;
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
  objects: CreationObjectView[];
  stages: ChangeStageResult[];
  createdObjects: Array<{
    objectType: CreationObjectType;
    objectName: string;
    actualObjectUrl: string;
    ownershipProven: boolean;
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
}
