import type { ToolProfile } from './types.js';
import type { RepositoryCreationContext, RepositoryObjectKind } from './repositoryCreationTypes.js';

export type RepositoryCleanupPlanStatus =
  | 'PREVIEWED'
  | 'APPLYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'EXPIRED';

export interface RepositoryCleanupResource {
  objectKind: RepositoryObjectKind;
  objectName: string;
  adtType: string;
  objectUrl: string;
  packageName: string;
  version: string;
  transportProgramId: string;
  transportObjectType: string;
  transportObjectName: string;
}

export interface PreparedRepositoryCleanup {
  target: RepositoryCleanupResource;
  resources: RepositoryCleanupResource[];
  transportRequest: string;
  dependencySummary: string[];
  summary: string;
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
  cleanupOrder: Array<Pick<RepositoryCleanupResource, 'objectKind' | 'objectName' | 'adtType'>>;
  resources?: RepositoryCleanupResource[];
  stages: RepositoryCleanupStageResult[];
  resultSummary?: string;
  primaryError?: { code: string; stage: string; message: string };
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
