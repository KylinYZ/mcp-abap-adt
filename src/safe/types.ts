import type {
  AbapObjectStructure,
  ActivationResult,
  AdtLock,
  MainInclude,
  SearchResult,
  SyntaxCheckResult,
  TransportInfo,
  TransportRequest
} from 'abap-adt-api';

export type SupportedObjectType = 'PROGRAM' | 'INCLUDE' | 'CLASS' | 'FUNCTION_MODULE';

export type ToolProfile = 'safe' | 'legacy-full';

export type ConfirmationMode = 'elicitation' | 'text-fallback';

export interface SafeAdtClient {
  searchObject(query: string, objType?: string, max?: number): Promise<SearchResult[]>;
  objectStructure(objectUrl: string, version?: 'active' | 'inactive' | 'workingArea'): Promise<AbapObjectStructure>;
  mainPrograms(includeUrl: string): Promise<MainInclude[]>;
  transportInfo(objectUrl: string, devClass?: string, operation?: string): Promise<TransportInfo>;
  transportDetails(transportNumber: string): Promise<TransportRequest>;
  getObjectSource(objectSourceUrl: string): Promise<string>;
  setObjectSource(objectSourceUrl: string, source: string, lockHandle: string, transport?: string): Promise<void>;
  syntaxCheck(
    artifactUrl: string,
    objectUrl: string,
    content: string,
    mainProgram?: string,
    version?: string
  ): Promise<SyntaxCheckResult[]>;
  lock(objectUrl: string, accessMode?: string): Promise<AdtLock>;
  unLock(objectUrl: string, lockHandle: string): Promise<string>;
  activate(objectName: string, objectUrl: string, mainInclude?: string, preauditRequested?: boolean): Promise<ActivationResult>;
}

export interface ResolvedAbapObject {
  objectType: SupportedObjectType;
  objectName: string;
  adtType: string;
  objectUrl: string;
  sourceUrl: string;
  lockUrl: string;
  activationName: string;
  activationUrl: string;
  mainProgram?: string;
  packageName?: string;
  parentObject?: string;
}

export interface DiffSummary {
  addedLines: number;
  removedLines: number;
  unchangedPrefixLines: number;
  unchangedSuffixLines: number;
}

export interface ChangeStageResult {
  stage: string;
  success: boolean;
  timestamp: string;
  message?: string;
}

export type ChangePlanStatus =
  | 'PREVIEWED'
  | 'APPLYING'
  | 'APPLIED'
  | 'FAILED'
  | 'ROLLED_BACK'
  | 'ROLLBACK_FAILED'
  | 'EXPIRED';

export interface ChangePlan {
  changePlanId: string;
  createdAt: number;
  expiresAt: number;
  status: ChangePlanStatus;
  systemHost: string;
  client: string;
  object: ResolvedAbapObject;
  transportRequest: string;
  originalSource: string;
  targetSource: string;
  originalHash: string;
  targetHash: string;
  diff: string;
  diffSummary: DiffSummary;
  syntaxMessages: SyntaxCheckResult[];
  stages: ChangeStageResult[];
  primaryError?: {
    code: string;
    stage: string;
    message: string;
  };
  rollbackAttempted?: boolean;
  rollbackSucceeded?: boolean;
  unlockSucceeded?: boolean;
  confirmationMode?: ConfirmationMode;
}

export interface ChangePlanView {
  changePlanId: string;
  createdAt: string;
  expiresAt: string;
  status: ChangePlanStatus;
  systemHost: string;
  client: string;
  object: ResolvedAbapObject;
  transportRequest: string;
  originalHash: string;
  targetHash: string;
  diffSummary: DiffSummary;
  syntaxMessages: SyntaxCheckResult[];
  stages: ChangeStageResult[];
  primaryError?: ChangePlan['primaryError'];
  rollbackAttempted?: boolean;
  rollbackSucceeded?: boolean;
  unlockSucceeded?: boolean;
}
