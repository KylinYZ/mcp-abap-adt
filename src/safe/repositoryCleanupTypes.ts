import type { ToolProfile } from './types.js';
import type { RepositoryCreationContext, RepositoryObjectKind } from './repositoryCreationTypes.js';

export type RepositoryCleanupPlanStatus =
  | 'PREVIEWED'
  | 'APPLYING'
  | 'COMPLETED'
  | 'COMPLETED_LOCAL_ABSENCE'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'EXPIRED';

export interface RepositoryCleanupResource {
  objectKind: RepositoryObjectKind;
  objectName: string;
  parentName?: string;
  adtType: string;
  objectUrl: string;
  packageName: string;
  version: string;
  transportProgramId: string;
  transportObjectType: string;
  transportObjectName: string;
  transportIdentityAliases?: Array<{
    programId: string;
    objectType: string;
    objectName: string;
  }>;
  cleanupMode?: 'DIRECT' | 'CASCADE_VERIFY';
  transportCompanionKeys?: Array<{
    programId: string;
    objectType: string;
    objectName: string;
  }>;
  /** 恢复清理（recover-failed-create）中对象仅以 inactive 版本可解析时冻结的版本偏好。 */
  recoveryVersion?: 'active' | 'inactive';
}

/** 恢复清理的溯源信息：绑定触发恢复的那次失败创建计划（plan 与 review 均可见）。 */
export interface RepositoryCleanupRecoveryProvenance {
  creationPlanId: string;
  creationPlanStatus: string;
  primaryErrorCode?: string;
}

export interface PreparedRepositoryCleanup {
  target: RepositoryCleanupResource;
  resources: RepositoryCleanupResource[];
  transportRequest: string;
  dependencySummary: string[];
  summary: string;
  recoveryOf?: RepositoryCleanupRecoveryProvenance;
}

export interface RepositoryCleanupStageResult {
  stage: string;
  success: boolean;
  timestamp: string;
  message?: string;
}

export interface RepositoryCleanupPlan {
  cleanupPlanId: string;
  createdAt: number;
  expiresAt: number;
  status: RepositoryCleanupPlanStatus;
  terminalAt?: number;
  context: RepositoryCreationContext;
  target: RepositoryCleanupResource;
  transportRequest: string;
  dependencySummary: string[];
  summary: string;
  payloadHash: string;
  payloadBytes: number;
  cleanupOrder: Array<Pick<RepositoryCleanupResource, 'objectKind' | 'objectName' | 'adtType' | 'cleanupMode'>>;
  resources?: RepositoryCleanupResource[];
  stages: RepositoryCleanupStageResult[];
  resultSummary?: string;
  transportDisposition?: 'DELETION_ENTRY_VERIFIED' | 'NEUTRAL_ENTRIES_VERIFIED' | 'NO_TRANSPORT_ENTRY_VERIFIED';
  primaryError?: { code: string; stage: string; message: string };
  /** 恢复清理溯源（仅 previewRepositoryObjectCleanup 携带 creationPlanId 时存在）。 */
  recoveryOf?: RepositoryCleanupRecoveryProvenance;
}

export type RepositoryCleanupPlanView = Omit<RepositoryCleanupPlan, 'createdAt' | 'expiresAt' | 'terminalAt' | 'resources' | 'context'> & {
  createdAt: string;
  expiresAt: string;
  terminalAt?: string;
  systemHost: string;
  client: string;
  sapUser: string;
  systemRole: string;
  toolProfile: ToolProfile;
};
