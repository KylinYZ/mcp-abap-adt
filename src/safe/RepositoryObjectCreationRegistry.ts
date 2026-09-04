import { SafeAbapError } from './errors.js';
import {
  REPOSITORY_CREATION_MATURITY_EVIDENCE,
  validateRepositoryCreationMaturityEvidence,
  type RepositoryCreationMaturityEvidenceManifest
} from './RepositoryCreationMaturityEvidence.js';
import type {
  RepositoryCreationCapabilityDefinition,
  RepositoryCreationCapabilityView,
  RepositoryCreationContext,
  RepositoryCreationDescription,
  RepositoryObjectKind
} from './repositoryCreationTypes.js';

export class RepositoryObjectCreationRegistry {
  private readonly byKind = new Map<RepositoryObjectKind, RepositoryCreationCapabilityDefinition>();
  private readonly byAdtType = new Map<string, RepositoryCreationCapabilityDefinition>();

  constructor(
    definitions: RepositoryCreationCapabilityDefinition[] = [],
    maturityEvidence: RepositoryCreationMaturityEvidenceManifest = REPOSITORY_CREATION_MATURITY_EVIDENCE
  ) {
    for (const definition of definitions) this.register(definition);
    // A maturity label can enable mutation, so it must never outrun checked-in lifecycle evidence.
    validateRepositoryCreationMaturityEvidence([...this.byKind.values()], maturityEvidence);
  }

  register(definition: RepositoryCreationCapabilityDefinition): void {
    if (this.byKind.has(definition.objectKind)) {
      throw new Error(`Repository creation kind '${definition.objectKind}' is already registered.`);
    }
    const normalizedAdtType = normalizeAdtType(definition.adtType);
    if (this.byAdtType.has(normalizedAdtType)) {
      throw new Error(`Repository creation ADT type '${normalizedAdtType}' is already registered.`);
    }
    const stored = clone({ ...definition, adtType: normalizedAdtType });
    this.byKind.set(stored.objectKind, stored);
    this.byAdtType.set(stored.adtType, stored);
  }

  list(context: RepositoryCreationContext): RepositoryCreationCapabilityView[] {
    return [...this.byKind.values()]
      .sort((left, right) => left.objectKind.localeCompare(right.objectKind))
      .map(definition => this.toCapability(definition, context));
  }

  describe(objectKind: string, context: RepositoryCreationContext): RepositoryCreationDescription {
    const definition = this.requireByKind(objectKind);
    return clone({
      ...this.toCapability(definition, context),
      summary: definition.summary,
      inputSchema: definition.inputSchema,
      fixedDefaults: definition.fixedDefaults,
      validationRules: definition.validationRules,
      executionStages: definition.executionStages,
      compensationLimits: definition.compensationLimits
    });
  }

  findByAdtType(adtType: string, context: RepositoryCreationContext): RepositoryCreationCapabilityView | undefined {
    const definition = this.byAdtType.get(normalizeAdtType(adtType));
    return definition ? this.toCapability(definition, context) : undefined;
  }

  private requireByKind(objectKind: string): RepositoryCreationCapabilityDefinition {
    const normalized = String(objectKind || '').trim().toUpperCase() as RepositoryObjectKind;
    const definition = this.byKind.get(normalized);
    if (!definition) {
      throw new SafeAbapError(
        'VALIDATION_FAILED',
        'capability',
        `Repository creation kind '${normalized || '(empty)'}' is not registered.`
      );
    }
    return definition;
  }

  private toCapability(
    definition: RepositoryCreationCapabilityDefinition,
    context: RepositoryCreationContext
  ): RepositoryCreationCapabilityView {
    const profileAllowsWrite = context.toolProfile === 'development'
      || context.toolProfile === 'development-workbench';
    const realDevVerified = definition.maturity === 'REAL_DEV_VERIFIED';
    // Visibility is broader than mutation: only a fully verified DEV adapter may become writable.
    const writable = definition.targetAvailable
      && context.systemRole === 'DEV'
      && profileAllowsWrite
      && realDevVerified;

    return clone({
      objectKind: definition.objectKind,
      adtType: definition.adtType,
      displayName: definition.displayName,
      family: definition.family,
      ...(definition.parentKind ? { parentKind: definition.parentKind } : {}),
      maturity: definition.maturity,
      available: definition.targetAvailable,
      writable,
      ...(!writable ? { unavailableReason: writeUnavailableReason(definition, context, profileAllowsWrite) } : {}),
      evidenceSources: definition.evidenceSources,
      requirements: definition.requirements
    });
  }
}

function writeUnavailableReason(
  definition: RepositoryCreationCapabilityDefinition,
  context: RepositoryCreationContext,
  profileAllowsWrite: boolean
): string {
  if (!definition.targetAvailable) {
    return definition.targetUnavailableReason || 'The target system does not expose the required ADT creation capability.';
  }
  if (definition.maturity !== 'REAL_DEV_VERIFIED') {
    return `Write support remains disabled until this adapter reaches REAL_DEV_VERIFIED; current maturity is ${definition.maturity}.`;
  }
  if (context.systemRole !== 'DEV') return 'Write support requires SAP_MCP_SYSTEM_ROLE=DEV.';
  if (!profileAllowsWrite) return 'Write support requires the development or development-workbench profile.';
  return 'Write support is unavailable for the current connection.';
}

function normalizeAdtType(adtType: string): string {
  return String(adtType || '').trim().toUpperCase();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
