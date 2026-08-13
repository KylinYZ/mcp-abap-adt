export type SafeErrorCode =
  | 'POLICY_DENIED'
  | 'CONFIRMATION_UNSUPPORTED'
  | 'OBJECT_RESOLUTION_FAILED'
  | 'INVALID_CREATION_GRAPH'
  | 'OBJECT_ALREADY_EXISTS'
  | 'PARENT_NOT_FOUND'
  | 'OBJECT_VALIDATION_FAILED'
  | 'OBJECT_CREATION_FAILED'
  | 'SOURCE_WRITE_FAILED'
  | 'SOURCE_VERIFY_FAILED'
  | 'COMPENSATION_FAILED'
  | 'TRANSPORT_INVALID'
  | 'SYNTAX_CHECK_FAILED'
  | 'SOURCE_DRIFT'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_EXPIRED'
  | 'PLAN_ALREADY_CONSUMED'
  | 'PLAN_CAPACITY_FULL'
  | 'LOCK_FAILED'
  | 'WRITE_FAILED'
  | 'ACTIVATION_FAILED'
  | 'VERIFY_FAILED'
  | 'ROLLBACK_FAILED'
  | 'UNLOCK_FAILED'
  | 'AUDIT_FAILED';

export class SafeAbapError extends Error {
  constructor(
    public readonly code: SafeErrorCode,
    public readonly stage: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(sanitizeMessage(message));
    this.name = 'SafeAbapError';
  }

  toResponse(): Record<string, unknown> {
    return {
      status: 'error',
      error: {
        code: this.code,
        stage: this.stage,
        message: this.message,
        nextStep: nextStepFor(this.code),
        ...(this.details ? { details: this.details } : {})
      }
    };
  }
}

function nextStepFor(code: SafeErrorCode): string {
  switch (code) {
    case 'POLICY_DENIED':
      return 'Review the safe-profile allowlists and request an authorized DEV target before retrying.';
    case 'CONFIRMATION_UNSUPPORTED':
      return 'Use an MCP client with form elicitation support or explicitly enable SAP_MCP_ALLOW_TEXT_CONFIRMATION.';
    case 'OBJECT_RESOLUTION_FAILED':
      return 'Verify the exact object type and name in ADT, then create a new preview.';
    case 'INVALID_CREATION_GRAPH':
      return 'Correct the object graph, parent fields, and complete source, then create a new creation preview.';
    case 'OBJECT_ALREADY_EXISTS':
      return 'Inspect the existing SAP object; safe creation will not overwrite or adopt it.';
    case 'PARENT_NOT_FOUND':
      return 'Verify the exact transportable package or parent function group before creating a new preview.';
    case 'OBJECT_VALIDATION_FAILED':
      return 'Correct the SAP object name or parent metadata reported by ADT, then create a new preview.';
    case 'OBJECT_CREATION_FAILED':
    case 'SOURCE_WRITE_FAILED':
    case 'SOURCE_VERIFY_FAILED':
    case 'COMPENSATION_FAILED':
      return 'Check the creation plan status and inspect the listed objects, locks, and transport in ADT before retrying.';
    case 'TRANSPORT_INVALID':
      return 'Choose an existing unreleased transport that SAP reports as available for this object.';
    case 'SYNTAX_CHECK_FAILED':
      return 'Correct the reported ABAP syntax errors and create a new preview.';
    case 'SOURCE_DRIFT':
      return 'Inspect the current SAP version and create a new preview from that source.';
    case 'PLAN_NOT_FOUND':
    case 'PLAN_EXPIRED':
    case 'PLAN_ALREADY_CONSUMED':
      return 'Create and confirm a new change preview.';
    case 'PLAN_CAPACITY_FULL':
      return 'Wait for an active plan to finish or a retained recovery plan to expire before creating another preview.';
    case 'LOCK_FAILED':
      return 'Resolve the SAP object lock in ADT and retry with a new preview if the source changed.';
    case 'ROLLBACK_FAILED':
    case 'UNLOCK_FAILED':
      return 'Inspect the inactive object, lock, and transport manually in ADT/SAP before continuing.';
    case 'AUDIT_FAILED':
      return 'Restore write access to SAP_MCP_AUDIT_PATH before attempting another source change.';
    case 'WRITE_FAILED':
    case 'ACTIVATION_FAILED':
    case 'VERIFY_FAILED':
      return 'Check the returned plan recovery status and inspect the object in ADT before retrying.';
  }
}

export function sanitizeMessage(message: string): string {
  return String(message || 'Unknown error')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/(password|passwd|pwd|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 2000);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const responseMessage = (error as Error & { response?: { data?: { message?: string } } }).response?.data?.message;
    return sanitizeMessage(responseMessage || error.message);
  }
  return sanitizeMessage(String(error));
}
