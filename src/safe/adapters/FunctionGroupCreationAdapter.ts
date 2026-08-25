import type { CreationObjectInput } from '../creationTypes.js'
import type {
  PreparedRepositoryCreation,
  RepositoryCreationExecutionResult,
  RepositoryCreationPlan,
  RepositoryObjectCreationAdapter
} from '../repositoryCreationTypes.js'
import { repositoryName, requiredString } from './creationAdapterTools.js'
import {
  executeLegacy,
  legacyCompensationResult,
  type LegacyAbapCreationWorkflow,
  preparedFromLegacy,
  requiredSource
} from './AbapSourceCreationAdapter.js'

export class FunctionGroupCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'FUNCTION_GROUP' as const

  constructor(private readonly workflow: LegacyAbapCreationWorkflow) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const groupName = repositoryName(request, 'name', 26)
    const group: CreationObjectInput = {
      objectType: 'FUNCTION_GROUP', objectName: groupName,
      description: requiredString(request, 'description', 120),
      packageName: repositoryName(request, 'packageName', 30)
    }
    const initial = request.initialFunctionModule
    if (!initial || typeof initial !== 'object' || Array.isArray(initial)) {
      throw new Error('initialFunctionModule is required for controlled function-group creation.')
    }
    const module = initial as Record<string, unknown>
    const initialFunctionModule: CreationObjectInput = {
      objectType: 'FUNCTION_MODULE',
      objectName: repositoryName(module, 'name', 30),
      description: requiredString(module, 'description', 120),
      parentFunctionGroup: groupName,
      source: requiredSource(module.source)
    }
    const transportRequest = requiredString(request, 'transportRequest', 10).toUpperCase()
    const preview = await this.workflow.preview({ objects: [group, initialFunctionModule], transportRequest })
    return preparedFromLegacy(this.objectKind, preview, this.workflow)
  }

  execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    return executeLegacy(plan, recordStage, this.workflow)
  }

  async compensate(plan: RepositoryCreationPlan): Promise<boolean> {
    return legacyCompensationResult(plan, this.workflow)
  }
}
