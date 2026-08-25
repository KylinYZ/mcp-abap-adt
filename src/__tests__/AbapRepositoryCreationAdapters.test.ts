import { AbapSourceCreationAdapter, FunctionGroupIncludeCreationAdapter, type LegacyAbapCreationWorkflow } from '../safe/adapters/AbapSourceCreationAdapter'
import { FunctionGroupCreationAdapter } from '../safe/adapters/FunctionGroupCreationAdapter'
import { RepositoryCreationOutcomeUnknownError } from '../safe/RepositoryObjectCreationWorkflow'
import type { CreationPlanView } from '../safe/creationTypes'
import type { PreparedRepositoryCreation, RepositoryCreationPlan } from '../safe/repositoryCreationTypes'

const programSource = 'REPORT znew.\nWRITE / test.'
const moduleSource = 'FUNCTION znew_fm.\nENDFUNCTION.'

function legacy(statusOverrides: Partial<CreationPlanView> = {}): jest.Mocked<LegacyAbapCreationWorkflow> {
  const status: CreationPlanView = {
    creationPlanId: 'legacy-1', createdAt: '2026-08-19T00:00:00.000Z', expiresAt: '2099-08-19T00:15:00.000Z',
    status: 'PREVIEWED', systemHost: 'dev.example.test', client: '100', transportRequest: 'DEVK900001',
    objects: [{
      objectType: 'PROGRAM', objectName: 'ZNEW', description: 'New program', packageName: 'Z001',
      objectUrl: '/sap/bc/adt/programs/programs/znew', sourceHash: 'source-hash'
    }],
    stages: [], createdObjects: [], ...statusOverrides
  }
  return {
    preview: jest.fn().mockResolvedValue({
      status: 'preview', plan: { creationPlanId: 'legacy-1' },
      sources: [{ objectType: 'PROGRAM', objectName: 'ZNEW', source: programSource, sourceHash: 'source-hash' }],
      deferredObjectValidation: [],
      compensationWarning: 'Compensation is best effort.'
    }),
    apply: jest.fn().mockImplementation(async () => {
      status.status = 'APPLIED'
      status.createdObjects = [{
        objectType: 'PROGRAM', objectName: 'ZNEW', actualObjectUrl: '/sap/bc/adt/programs/programs/znew',
        ownershipProven: true, sourceMatchType: 'EXACT'
      }]
      status.stages = [{ stage: 'OBJECT_CREATED:ZNEW', success: true, timestamp: '2026-08-19T00:00:01.000Z' }]
      return { status: 'success', plan: status }
    }),
    status: jest.fn().mockImplementation(() => status)
  }
}

describe('ABAP compatibility repository creation adapters', () => {
  it('previews a program through the legacy controlled workflow and exposes complete review source', async () => {
    const workflow = legacy()
    const adapter = new AbapSourceCreationAdapter('PROGRAM', workflow)
    const prepared = await adapter.prepare({
      name: 'ZNEW', description: 'New program', packageName: 'Z001', source: programSource,
      transportRequest: 'DEVK900001'
    })
    expect(workflow.preview).toHaveBeenCalledWith({
      objects: [{ objectType: 'PROGRAM', objectName: 'ZNEW', description: 'New program', packageName: 'Z001', source: programSource }],
      transportRequest: 'DEVK900001'
    })
    expect(prepared.review).toMatchObject({
      objectKind: 'PROGRAM', sources: [{ objectName: 'ZNEW', source: programSource }]
    })
    expect(prepared.payload).toMatchObject({ review: { sources: [{ source: programSource }] } })
    expect(workflow.apply).not.toHaveBeenCalled()

    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toEqual({
      resultSummary: 'Created and verified ZNEW.', actualResources: [{ type: 'PROG/P', name: 'ZNEW' }]
    })
    expect(workflow.apply).toHaveBeenCalledWith({
      creationPlanId: 'legacy-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })
    expect(stages).toEqual(['LEGACY:OBJECT_CREATED:ZNEW'])
  })

  it('translates function-group input into the required group-plus-first-module graph', async () => {
    const workflow = legacy({
      objects: [
        {
          objectType: 'FUNCTION_GROUP', objectName: 'ZNEW_FG', description: 'New group', packageName: 'Z001',
          objectUrl: '/sap/bc/adt/functions/groups/znew_fg'
        },
        {
          objectType: 'FUNCTION_MODULE', objectName: 'ZNEW_FM', description: 'New module', packageName: 'Z001',
          parentFunctionGroup: 'ZNEW_FG', objectUrl: '/sap/bc/adt/functions/groups/znew_fg/fmodules/znew_fm',
          sourceHash: 'module-hash'
        }
      ]
    })
    workflow.preview.mockResolvedValue({
      status: 'preview', plan: { creationPlanId: 'legacy-1' },
      sources: [{ objectType: 'FUNCTION_MODULE', objectName: 'ZNEW_FM', source: moduleSource }],
      deferredObjectValidation: ['ZNEW_FM'], compensationWarning: 'Compensation is best effort.'
    })
    const adapter = new FunctionGroupCreationAdapter(workflow)
    const prepared = await adapter.prepare({
      name: 'ZNEW_FG', description: 'New group', packageName: 'Z001', transportRequest: 'DEVK900001',
      initialFunctionModule: { name: 'ZNEW_FM', description: 'New module', source: moduleSource }
    })
    expect(workflow.preview).toHaveBeenCalledWith({
      objects: [
        { objectType: 'FUNCTION_GROUP', objectName: 'ZNEW_FG', description: 'New group', packageName: 'Z001' },
        {
          objectType: 'FUNCTION_MODULE', objectName: 'ZNEW_FM', description: 'New module',
          parentFunctionGroup: 'ZNEW_FG', source: moduleSource
        }
      ],
      transportRequest: 'DEVK900001'
    })
    expect(prepared).toMatchObject({
      target: { objectKind: 'FUNCTION_GROUP', objectName: 'ZNEW_FG', adtType: 'FUGR/F' },
      review: { deferredObjectValidation: ['ZNEW_FM'] }
    })
  })

  it('maps uncertain legacy ownership to OUTCOME_UNKNOWN without another compensation attempt', async () => {
    const workflow = legacy({
      status: 'COMPENSATION_FAILED',
      createdObjects: [{
        objectType: 'PROGRAM', objectName: 'ZNEW', actualObjectUrl: '/sap/bc/adt/programs/programs/znew',
        ownershipProven: false
      }],
      primaryError: { code: 'OBJECT_CREATION_FAILED', stage: 'create', message: 'Connection reset.' }
    })
    workflow.apply.mockRejectedValue(new Error('Connection reset.'))
    const adapter = new AbapSourceCreationAdapter('PROGRAM', workflow)
    const prepared = await adapter.prepare({
      name: 'ZNEW', description: 'New program', packageName: 'Z001', source: programSource,
      transportRequest: 'DEVK900001'
    })
    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    await expect(adapter.compensate!(plan(prepared))).rejects.toThrow('compensation failed')
    expect(workflow.apply).toHaveBeenCalledTimes(1)
  })

  it('previews a function-group include with the public suffix and full derived target', async () => {
    const workflow = legacy({ objects: [{
      objectType: 'FUNCTION_GROUP_INCLUDE', objectName: 'LZNEWFGTOP', description: 'Top include', packageName: 'Z001',
      parentFunctionGroup: 'ZNEW_FG', objectUrl: '/sap/bc/adt/functions/groups/znew_fg/includes/lznewfgtop',
      sourceHash: 'include-hash'
    }] });
    workflow.preview.mockResolvedValue({
      status: 'preview', plan: { creationPlanId: 'legacy-1' },
      sources: [{ objectType: 'FUNCTION_GROUP_INCLUDE', objectName: 'LZNEWFGTOP', source: 'FUNCTION-POOL znew_fg.' }],
      deferredObjectValidation: [], compensationWarning: 'Compensation is best effort.'
    });
    const adapter = new FunctionGroupIncludeCreationAdapter(workflow);
    const prepared = await adapter.prepare({
      name: 'TOP', description: 'Top include', parentFunctionGroup: 'ZNEW_FG', source: 'FUNCTION-POOL znew_fg.', transportRequest: 'DEVK900001'
    });
    expect(workflow.preview).toHaveBeenCalledWith({
      objects: [{ objectType: 'FUNCTION_GROUP_INCLUDE', objectName: 'TOP', description: 'Top include', parentFunctionGroup: 'ZNEW_FG', source: 'FUNCTION-POOL znew_fg.' }],
      transportRequest: 'DEVK900001'
    });
    expect(prepared).toMatchObject({
      target: { objectKind: 'FUNCTION_GROUP_INCLUDE', objectName: 'LZNEWFGTOP', adtType: 'FUGR/I', parentName: 'ZNEW_FG', packageName: 'Z001' }
    });
  });

  it('reports legacy compensation without issuing a second remote mutation', async () => {
    const workflow = legacy({ status: 'COMPENSATED' })
    workflow.apply.mockRejectedValue(new Error('Syntax rejected; compensated.'))
    const adapter = new AbapSourceCreationAdapter('PROGRAM', workflow)
    const prepared = await adapter.prepare({
      name: 'ZNEW', description: 'New program', packageName: 'Z001', source: programSource,
      transportRequest: 'DEVK900001'
    })
    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toThrow('compensated')
    await expect(adapter.compensate!(plan(prepared))).resolves.toBe(true)
    expect(workflow.apply).toHaveBeenCalledTimes(1)
  })

  it('preserves a known legacy compensation failure without retrying it', async () => {
    const workflow = legacy({ status: 'COMPENSATION_FAILED' })
    const adapter = new AbapSourceCreationAdapter('PROGRAM', workflow)
    const prepared = await adapter.prepare({
      name: 'ZNEW', description: 'New program', packageName: 'Z001', source: programSource,
      transportRequest: 'DEVK900001'
    })
    await expect(adapter.compensate!(plan(prepared))).rejects.toThrow('compensation failed')
    expect(workflow.apply).not.toHaveBeenCalled()
  })
})

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return {
    creationPlanId: 'repository-1', createdAt: 1, expiresAt: 2, status: 'APPLYING',
    context: { systemHost: 'dev.example.test', client: '100', sapUser: 'TEST', systemRole: 'DEV', toolProfile: 'development' },
    target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary,
    payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits
  }
}
