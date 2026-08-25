import type { CreationObjectInput, CreationPlanView } from '../creationTypes.js'
import { errorMessage } from '../errors.js'
import { RepositoryCreationOutcomeUnknownError } from '../RepositoryObjectCreationWorkflow.js'
import type {
  PreparedRepositoryCreation,
  RepositoryCreationExecutionResult,
  RepositoryCreationPlan,
  RepositoryObjectCreationAdapter
} from '../repositoryCreationTypes.js'
import type { RepositoryObjectKind } from '../repositoryCreationTypes.js'
import { repositoryName, requiredString } from './creationAdapterTools.js'

export interface LegacyAbapCreationWorkflow {
  preview(input: { objects: CreationObjectInput[]; transportRequest: string }): Promise<Record<string, unknown>>
  apply(input: {
    creationPlanId: string
    confirmedByUser: boolean
    confirmationMode: 'elicitation'
  }): Promise<Record<string, unknown>>
  status(creationPlanId: string): CreationPlanView
}

interface LegacyCreationPayload {
  legacyCreationPlanId: string
  review: Record<string, unknown>
}

export class AbapSourceCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind: Extract<RepositoryObjectKind, 'PROGRAM' | 'FUNCTION_MODULE'>

  constructor(
    objectKind: 'PROGRAM' | 'FUNCTION_MODULE',
    protected readonly workflow: LegacyAbapCreationWorkflow
  ) {
    this.objectKind = objectKind
  }

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const object = this.objectInput(request)
    const transportRequest = requiredString(request, 'transportRequest', 10).toUpperCase()
    const preview = await this.workflow.preview({ objects: [object], transportRequest })
    return preparedFromLegacy(this.objectKind, preview, this.workflow)
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    return executeLegacy(plan, recordStage, this.workflow)
  }

  async compensate(plan: RepositoryCreationPlan): Promise<boolean> {
    return legacyCompensationResult(plan, this.workflow)
  }

  protected objectInput(request: Record<string, unknown>): CreationObjectInput {
    const objectName = repositoryName(request, 'name', this.objectKind === 'PROGRAM' ? 40 : 30)
    const description = requiredString(request, 'description', 120)
    const source = requiredSource(request.source)
    if (this.objectKind === 'PROGRAM') {
      return {
        objectType: 'PROGRAM', objectName, description,
        packageName: repositoryName(request, 'packageName', 30), source
      }
    }
    return {
      objectType: 'FUNCTION_MODULE', objectName, description,
      parentFunctionGroup: repositoryName(request, 'parentFunctionGroup', 26), source
    }
  }
}

export class FunctionGroupIncludeCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'FUNCTION_GROUP_INCLUDE' as const

  constructor(protected readonly workflow: LegacyAbapCreationWorkflow) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const suffix = requiredString(request, 'name', 3).toUpperCase()
    if (!/^[A-Z][A-Z0-9_]{2}$/.test(suffix)) throw new Error('name must be a three-character include suffix.')
    const object: CreationObjectInput = {
      objectType: 'FUNCTION_GROUP_INCLUDE', objectName: suffix,
      description: requiredString(request, 'description', 120),
      parentFunctionGroup: repositoryName(request, 'parentFunctionGroup', 26),
      source: requiredSource(request.source)
    }
    const transportRequest = requiredString(request, 'transportRequest', 10).toUpperCase()
    const preview = await this.workflow.preview({ objects: [object], transportRequest })
    return preparedFromLegacy(this.objectKind, preview, this.workflow)
  }

  execute(plan: RepositoryCreationPlan, recordStage: (stage: string, success: boolean, message?: string) => void): Promise<RepositoryCreationExecutionResult> {
    return executeLegacy(plan, recordStage, this.workflow)
  }

  async compensate(plan: RepositoryCreationPlan): Promise<boolean> {
    return legacyCompensationResult(plan, this.workflow)
  }
}

export function preparedFromLegacy(
  objectKind: RepositoryObjectKind,
  preview: Record<string, unknown>,
  workflow: LegacyAbapCreationWorkflow
): PreparedRepositoryCreation {
  const previewPlan = preview.plan as { creationPlanId?: string } | undefined
  const legacyCreationPlanId = String(previewPlan?.creationPlanId || '')
  if (!legacyCreationPlanId) throw new Error('Legacy controlled creation preview did not return a plan identifier.')
  const status = workflow.status(legacyCreationPlanId)
  const targetObject = status.objects.find(object => object.objectType === objectKind) || status.objects[0]
  if (!targetObject) throw new Error('Legacy controlled creation preview did not return an object graph.')
  const review = {
    objectKind,
    objectGraph: status.objects.map(object => ({
      objectType: object.objectType,
      objectName: object.objectName,
      description: object.description,
      packageName: object.packageName,
      parentFunctionGroup: object.parentFunctionGroup,
      sourceHash: object.sourceHash
    })),
    sources: preview.sources || [],
    deferredObjectValidation: preview.deferredObjectValidation || [],
    transportRequest: status.transportRequest
  }
  return {
    target: {
      objectKind,
      objectName: targetObject.objectName,
      adtType: adtType(objectKind),
      parentName: targetObject.parentFunctionGroup || targetObject.packageName,
      packageName: targetObject.packageName
    },
    transportRequest: status.transportRequest,
    summary: `Create ${status.objects.map(object => `${object.objectType} ${object.objectName}`).join(' and ')}.`,
    payload: { legacyCreationPlanId, review } satisfies LegacyCreationPayload,
    review,
    compensationLimits: [String(preview.compensationWarning || 'SAP ADT creation compensation is best effort.')]
  }
}

export async function executeLegacy(
  plan: RepositoryCreationPlan,
  recordStage: (stage: string, success: boolean, message?: string) => void,
  workflow: LegacyAbapCreationWorkflow
): Promise<RepositoryCreationExecutionResult> {
  const legacyCreationPlanId = legacyPlanId(plan)
  try {
    await workflow.apply({ creationPlanId: legacyCreationPlanId, confirmedByUser: true, confirmationMode: 'elicitation' })
  } catch (error) {
    const status = workflow.status(legacyCreationPlanId)
    copyStages(status, recordStage)
    plan.actualResources = resources(status)
    if (hasUnknownOutcome(status)) {
      throw new RepositoryCreationOutcomeUnknownError(`Legacy controlled creation outcome is unknown: ${errorMessage(error)}`)
    }
    throw error
  }
  const status = workflow.status(legacyCreationPlanId)
  copyStages(status, recordStage)
  const actualResources = resources(status)
  return {
    resultSummary: `Created and verified ${status.objects.map(object => object.objectName).join(', ')}.`,
    actualResources
  }
}

export function legacyStatus(plan: RepositoryCreationPlan, workflow: LegacyAbapCreationWorkflow): CreationPlanView {
  return workflow.status(legacyPlanId(plan))
}

export function legacyCompensationResult(
  plan: RepositoryCreationPlan,
  workflow: LegacyAbapCreationWorkflow
): boolean {
  const status = legacyStatus(plan, workflow)
  if (status.status === 'COMPENSATED') return true
  if (status.status === 'COMPENSATION_FAILED') {
    throw new Error('Legacy controlled creation compensation failed; no automatic retry was attempted.')
  }
  return false
}

function legacyPlanId(plan: RepositoryCreationPlan): string {
  const value = (plan.payload as LegacyCreationPayload | undefined)?.legacyCreationPlanId
  if (!value) throw new Error('Legacy controlled creation plan reference is unavailable.')
  return value
}

function copyStages(status: CreationPlanView, recordStage: (stage: string, success: boolean, message?: string) => void): void {
  for (const stage of status.stages) recordStage(`LEGACY:${stage.stage}`, stage.success, stage.message)
}

function resources(status: CreationPlanView): Array<{ type: string; name: string }> {
  return status.createdObjects.map(object => ({ type: adtType(object.objectType), name: object.objectName }))
}

function hasUnknownOutcome(status: CreationPlanView): boolean {
  return status.createdObjects.some(object => object.ownershipProven === false)
    || status.primaryError?.details?.activationOutcome === 'UNKNOWN'
}

function adtType(objectKind: string): string {
  if (objectKind === 'PROGRAM') return 'PROG/P'
  if (objectKind === 'FUNCTION_GROUP') return 'FUGR/F'
  if (objectKind === 'FUNCTION_GROUP_INCLUDE') return 'FUGR/I'
  return 'FUGR/FF'
}

export function requiredSource(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > 1_000_000) {
    throw new Error('source is required and must not exceed 1,000,000 UTF-8 bytes.')
  }
  if (/\u0000/.test(value)) throw new Error('source must not contain NUL characters.')
  return value
}
