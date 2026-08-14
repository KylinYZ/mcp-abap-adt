import type {
  ChangePackageRefactoring,
  DataElementMetaData,
  DataElementProperties,
  DomainMetaData,
  DomainProperties,
  RapGeneratorContent,
  RapGeneratorId,
  TextElement,
  TextElementCategory
} from '../adt/index.js';
import type { ToolProfile } from './types.js';

export type AdvancedOperationKind =
  | 'SET_DOMAIN_PROPERTIES'
  | 'SET_DATA_ELEMENT_PROPERTIES'
  | 'SET_TEXT_ELEMENTS'
  | 'CHANGE_PACKAGE'
  | 'RAP_GENERATE'
  | 'RAP_PUBLISH_SERVICE';

export type AdvancedOperationStatus =
  | 'PREVIEWED'
  | 'APPLYING'
  | 'APPLIED'
  | 'ROLLED_BACK'
  | 'ROLLBACK_FAILED'
  | 'PARTIAL_SUCCESS'
  | 'FAILED'
  | 'UNKNOWN_OUTCOME'
  | 'EXPIRED'
  | 'CANCELLED';

export interface AdvancedPlanContext {
  systemHost: string;
  client: string;
  systemRole: string;
  toolProfile: ToolProfile;
}

export interface AdvancedOperationTarget {
  objectType: string;
  objectName: string;
  packageName?: string;
}

export interface AdvancedOperationMessage {
  severity: 'info' | 'warning' | 'error';
  text: string;
}

export interface AdvancedOperationSummary {
  title: string;
  changedFields?: string[];
  affectedObjects?: Array<{ type: string; name: string }>;
  messages?: AdvancedOperationMessage[];
  warning: string;
}

export interface AdvancedStateSummary {
  stateHash: string;
  description: string;
}

interface DdicPayloadBase {
  objectUrl: string;
  activationUrl: string;
  lockHandle?: string;
}

export type AdvancedOperationPayload =
  | (DdicPayloadBase & {
      kind: 'SET_DOMAIN_PROPERTIES';
      input: { properties: DomainProperties; metaData: DomainMetaData };
      drift: { currentHash: string };
      recovery: { properties: DomainProperties; metaData: DomainMetaData };
      verification: { expectedHash: string };
    })
  | (DdicPayloadBase & {
      kind: 'SET_DATA_ELEMENT_PROPERTIES';
      input: { properties: DataElementProperties; metaData: DataElementMetaData };
      drift: { currentHash: string };
      recovery: { properties: DataElementProperties; metaData: DataElementMetaData };
      verification: { expectedHash: string };
    })
  | (DdicPayloadBase & {
      kind: 'SET_TEXT_ELEMENTS';
      input: { category: TextElementCategory; elements: TextElement[] };
      drift: { currentHash: string };
      recovery: { category: TextElementCategory; elements: TextElement[] };
      verification: { expectedHash: string };
    })
  | {
      kind: 'CHANGE_PACKAGE';
      input: { refactoring: ChangePackageRefactoring };
      drift: { previewHash: string; affectedObjectHash: string };
      verification: { expectedPackage: string };
    }
  | {
      kind: 'RAP_GENERATE';
      input: {
        genId: RapGeneratorId;
        refObjectUri: string;
        packageName: string;
        transport: string;
        content: RapGeneratorContent;
      };
      drift: { validationHash: string; previewHash: string };
      verification: { expectedObjects: Array<{ uri: string; type: string; name: string }> };
    }
  | {
      kind: 'RAP_PUBLISH_SERVICE';
      input: { serviceBindingName: string };
      drift: { observableStateHash?: string; stateObservable: boolean };
      verification: { expectedPublished: true };
    };

export interface AdvancedPayloadFingerprint {
  inputHash: string;
  inputBytes: number;
  driftHash: string;
  driftBytes: number;
  recoveryHash?: string;
  recoveryBytes?: number;
}

export interface AdvancedOperationStage {
  stage: string;
  success: boolean;
  timestamp: string;
  message?: string;
}

export interface AdvancedOperationError {
  code: string;
  stage: string;
  message: string;
}

export interface AdvancedOperationPlan {
  operationPlanId: string;
  createdAt: number;
  expiresAt: number;
  status: AdvancedOperationStatus;
  terminalAt?: number;
  context: AdvancedPlanContext;
  operationKind: AdvancedOperationKind;
  target: AdvancedOperationTarget;
  transport?: string;
  inputSummary: AdvancedOperationSummary;
  currentStateSummary: AdvancedStateSummary;
  payloadFingerprint: AdvancedPayloadFingerprint;
  payload?: AdvancedOperationPayload;
  rollbackSupported: boolean;
  stages: AdvancedOperationStage[];
  confirmationMode?: 'elicitation';
  resultSummary?: string;
  primaryError?: AdvancedOperationError;
}

export interface CreateAdvancedOperationPlanInput {
  context: AdvancedPlanContext;
  target: AdvancedOperationTarget;
  transport?: string;
  inputSummary: AdvancedOperationSummary;
  currentStateSummary: AdvancedStateSummary;
  payload: AdvancedOperationPayload;
  rollbackSupported: boolean;
}

export interface AdvancedOperationPlanView {
  operationPlanId: string;
  createdAt: string;
  expiresAt: string;
  status: AdvancedOperationStatus;
  systemHost: string;
  client: string;
  systemRole: string;
  toolProfile: ToolProfile;
  operationKind: AdvancedOperationKind;
  target: AdvancedOperationTarget;
  transport?: string;
  inputSummary: AdvancedOperationSummary;
  currentStateSummary: AdvancedStateSummary;
  payloadFingerprint: AdvancedPayloadFingerprint;
  rollbackSupported: boolean;
  stages: AdvancedOperationStage[];
  confirmationMode?: 'elicitation';
  resultSummary?: string;
  primaryError?: AdvancedOperationError;
}

export interface AdvancedOperationPreviewResult {
  status: 'preview';
  plan: AdvancedOperationPlanView;
  confirmationRequired: true;
}
