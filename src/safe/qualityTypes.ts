import type { AtcRunResult, UnitTestClass, UnitTestRunFlags } from '../adt/index.js';
import type { ResolvedAbapObject, ToolProfile } from './types.js';

export type QualityCheckKind = 'ABAP_UNIT' | 'ATC';
export type QualityCheckStatus = 'PREVIEWED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN_OUTCOME' | 'EXPIRED';

export interface QualityCheckContext {
  systemHost: string;
  client: string;
  sapUser: string;
  systemRole: string;
  toolProfile: ToolProfile;
}

export interface QualityObjectSnapshot {
  object: ResolvedAbapObject;
  sourceHash: string;
}

export interface QualityCheckPayload {
  kind: QualityCheckKind;
  objects: QualityObjectSnapshot[];
  variant?: string;
  flags: UnitTestRunFlags;
  timeoutMs: number;
}

export interface QualityCheckStage {
  stage: string;
  success: boolean;
  timestamp: string;
  message?: string;
}

export interface QualityCheckError {
  code: string;
  stage: string;
  message: string;
}

export interface QualityCheckPlan {
  qualityPlanId: string;
  createdAt: number;
  expiresAt: number;
  terminalAt?: number;
  status: QualityCheckStatus;
  context: QualityCheckContext;
  kind: QualityCheckKind;
  objects: Array<{
    objectType: string;
    objectName: string;
    adtType: string;
    packageName?: string;
  }>;
  variant?: string;
  riskLevel: 'HARMLESS' | 'DANGEROUS' | 'CRITICAL';
  duration: 'SHORT' | 'MEDIUM' | 'LONG';
  timeoutSeconds: number;
  stateHash: string;
  payload?: QualityCheckPayload;
  stages: QualityCheckStage[];
  confirmationMode?: 'elicitation';
  result?: QualityCheckResultSummary;
  primaryError?: QualityCheckError;
}

export interface CreateQualityCheckPlanInput {
  context: QualityCheckContext;
  kind: QualityCheckKind;
  objects: QualityObjectSnapshot[];
  variant?: string;
  riskLevel: QualityCheckPlan['riskLevel'];
  duration: QualityCheckPlan['duration'];
  timeoutSeconds: number;
  flags: UnitTestRunFlags;
}

export interface QualityCheckPlanView {
  qualityPlanId: string;
  createdAt: string;
  expiresAt: string;
  status: QualityCheckStatus;
  systemHost: string;
  client: string;
  sapUser: string;
  systemRole: string;
  toolProfile: ToolProfile;
  kind: QualityCheckKind;
  objects: QualityCheckPlan['objects'];
  variant?: string;
  riskLevel: QualityCheckPlan['riskLevel'];
  duration: QualityCheckPlan['duration'];
  timeoutSeconds: number;
  stateHash: string;
  stages: QualityCheckStage[];
  confirmationMode?: 'elicitation';
  result?: QualityCheckResultSummary;
  primaryError?: QualityCheckError;
}

export interface QualityCheckPreviewResult {
  status: 'preview';
  plan: QualityCheckPlanView;
  confirmationRequired: true;
}

export interface QualityVariantRequiredResult {
  status: 'variant_required';
  kind: 'ATC';
  configuredSystemVariant?: string;
  message: string;
  confirmationRequired: false;
}

export type QualityCheckResultSummary = UnitTestResultSummary | AtcResultSummary;

export interface UnitTestResultSummary {
  kind: 'ABAP_UNIT';
  classCount: number;
  methodCount: number;
  alertCount: number;
  truncated: boolean;
  classes: Array<{
    name: string;
    type: string;
    riskLevel: string;
    durationCategory: string;
    alertCount: number;
    methods: Array<{
      name: string;
      executionTime: number;
      unit: string;
      alerts: Array<{ kind: string; severity: string; title: string }>;
    }>;
  }>;
}

export interface AtcResultSummary {
  kind: 'ATC';
  runResultId: string;
  timestamp: number;
  infos: Array<{ type: string; description: string }>;
  truncated: boolean;
}

export type RawQualityCheckResult = UnitTestClass[] | AtcRunResult;
