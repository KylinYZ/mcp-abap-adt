import { SafeAbapError } from './errors.js';
import type { ToolProfile } from './types.js';
import { assertToolOperationAllowed as assertOperationAllowed } from '../config/ToolOperationPolicy.js';

export interface SafetyPolicyOptions {
  sapUrl?: string;
  sapClient?: string;
  sapUser?: string;
  systemRole?: string;
  allowedHosts?: string;
  allowedClients?: string;
  allowedNamespaces?: string;
  planTtlSeconds?: string;
  auditPath?: string;
  toolProfile?: string;
  allowTextConfirmation?: string;
  allowedDebugUsers?: string;
  debugAuthTtlSeconds?: string;
}

export class SafetyPolicy {
  readonly systemHost: string;
  readonly client: string;
  readonly sapUser: string;
  readonly systemRole: string;
  readonly allowedHosts: Set<string>;
  readonly allowedClients: Set<string>;
  readonly allowedNamespaces: string[];
  readonly planTtlMs: number;
  readonly auditPath?: string;
  readonly toolProfile: ToolProfile;
  readonly allowTextConfirmation: boolean;
  readonly allowedDebugUsers: Set<string>;
  readonly debugAuthTtlMs: number;

  constructor(options: SafetyPolicyOptions) {
    this.systemHost = parseHost(options.sapUrl);
    this.client = String(options.sapClient || '').trim();
    this.sapUser = normalizeSapUser(options.sapUser);
    this.systemRole = String(options.systemRole || '').trim().toUpperCase();
    this.allowedHosts = csvSet(options.allowedHosts, value => value.toLowerCase());
    this.allowedClients = csvSet(options.allowedClients);
    this.allowedNamespaces = [...csvSet(options.allowedNamespaces, value => value.toUpperCase())]
      .sort((left, right) => right.length - left.length);
    this.planTtlMs = parseTtl(options.planTtlSeconds);
    this.auditPath = options.auditPath?.trim() || undefined;
    this.toolProfile = parseToolProfile(options.toolProfile);
    this.allowTextConfirmation = parseBooleanFlag(options.allowTextConfirmation);
    const configuredDebugUsers = csvSet(options.allowedDebugUsers, normalizeSapUser);
    this.allowedDebugUsers = configuredDebugUsers.size > 0
      ? configuredDebugUsers
      : new Set(this.sapUser ? [this.sapUser] : []);
    this.debugAuthTtlMs = parseDebugAuthTtl(options.debugAuthTtlSeconds);
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): SafetyPolicy {
    return new SafetyPolicy({
      sapUrl: environment.SAP_URL,
      sapClient: environment.SAP_CLIENT,
      sapUser: environment.SAP_USER,
      systemRole: environment.SAP_MCP_SYSTEM_ROLE,
      allowedHosts: environment.SAP_MCP_ALLOWED_HOSTS,
      allowedClients: environment.SAP_MCP_ALLOWED_CLIENTS,
      allowedNamespaces: environment.SAP_MCP_ALLOWED_NAMESPACES,
      planTtlSeconds: environment.SAP_MCP_CHANGE_PLAN_TTL_SECONDS,
      auditPath: environment.SAP_MCP_AUDIT_PATH,
      toolProfile: environment.SAP_MCP_TOOL_PROFILE,
      allowTextConfirmation: environment.SAP_MCP_ALLOW_TEXT_CONFIRMATION,
      allowedDebugUsers: environment.SAP_MCP_ALLOWED_DEBUG_USERS,
      debugAuthTtlSeconds: environment.SAP_MCP_DEBUG_AUTH_TTL_SECONDS
    });
  }

  assertReadAllowed(objectName: string): void {
    const sourceReadAllowed = this.toolProfile === 'development'
      || this.toolProfile === 'development-workbench'
      || this.toolProfile === 'diagnostic-readonly'
      ? new Set(['DEV', 'QAS', 'PRD']).has(this.systemRole)
      : this.systemRole === 'DEV';
    if (!sourceReadAllowed) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'The configured system role is not allowed for source access in this tool profile.');
    }
    if (!this.systemHost || !this.allowedHosts.has(this.systemHost)) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'The SAP host is not in SAP_MCP_ALLOWED_HOSTS.');
    }
    if (!/^\d{3}$/.test(this.client) || !this.allowedClients.has(this.client)) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'The SAP client is not in SAP_MCP_ALLOWED_CLIENTS.');
    }
    if (this.allowedNamespaces.length === 0) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'SAP_MCP_ALLOWED_NAMESPACES must define at least one namespace.');
    }
    const normalizedName = normalizeObjectName(objectName);
    if (!this.allowedNamespaces.some(namespace => normalizedName.startsWith(namespace))) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', `Object ${normalizedName} is outside the allowed namespaces.`);
    }
  }

  assertMutationAllowed(objectName: string): void {
    if (this.toolProfile !== 'safe' && this.toolProfile !== 'development' && this.toolProfile !== 'development-workbench') {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'Source mutations require the safe, development, or development-workbench tool profile.');
    }
    if (this.systemRole !== 'DEV') {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'Source mutations require SAP_MCP_SYSTEM_ROLE=DEV.');
    }
    this.assertReadAllowed(objectName);
    if (!this.auditPath) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'SAP_MCP_AUDIT_PATH is required for source changes.');
    }
  }

  assertDebugControlAllowed(targetUser: string): string {
    if (this.toolProfile !== 'development' && this.toolProfile !== 'development-workbench') {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'Debug control requires the development or development-workbench tool profile.');
    }
    if (this.systemRole !== 'DEV') {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'Debug control requires SAP_MCP_SYSTEM_ROLE=DEV.');
    }
    if (!this.systemHost || !this.allowedHosts.has(this.systemHost)) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'The SAP host is not in SAP_MCP_ALLOWED_HOSTS.');
    }
    if (!/^\d{3}$/.test(this.client) || !this.allowedClients.has(this.client)) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'The SAP client is not in SAP_MCP_ALLOWED_CLIENTS.');
    }
    if (!this.auditPath) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'SAP_MCP_AUDIT_PATH is required for debug control.');
    }

    const normalizedUser = normalizeSapUser(targetUser);
    if (!normalizedUser || !this.allowedDebugUsers.has(normalizedUser)) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', `SAP user ${normalizedUser || '(empty)'} is not in SAP_MCP_ALLOWED_DEBUG_USERS.`);
    }
    return normalizedUser;
  }

  assertQualityCheckAllowed(objectName: string): void {
    if (this.toolProfile !== 'development-workbench' || this.systemRole !== 'DEV') {
      throw new SafeAbapError(
        'POLICY_DENIED',
        'policy',
        'Quality checks require SAP_MCP_SYSTEM_ROLE=DEV with the development-workbench profile.'
      );
    }
    this.assertReadAllowed(objectName);
    if (!this.auditPath) {
      throw new SafeAbapError('POLICY_DENIED', 'policy', 'SAP_MCP_AUDIT_PATH is required for quality checks.');
    }
  }

  assertTransportFormat(transportRequest: string): string {
    const normalized = String(transportRequest || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(normalized)) {
      throw new SafeAbapError('TRANSPORT_INVALID', 'transport', 'An existing ten-character transport request is required.');
    }
    return normalized;
  }

  assertTransportablePackage(packageName?: string): string {
    const normalized = String(packageName || '').trim().toUpperCase();
    if (!normalized || normalized === '$TMP') {
      throw new SafeAbapError(
        'POLICY_DENIED',
        'transport',
        'Source changes require a transportable package; local package $TMP is not allowed.'
      );
    }
    return normalized;
  }

  assertToolOperationAllowed(toolName: string): void {
    assertOperationAllowed(toolName, this.toolProfile, this.systemRole);
  }
}

export function parseToolProfile(value?: string): ToolProfile {
  const normalized = String(value || 'safe').trim().toLowerCase();
  if (normalized === 'safe'
    || normalized === 'development'
    || normalized === 'diagnostic-readonly'
    || normalized === 'legacy-full'
    || normalized === 'development-workbench'
    || normalized === 'business-readonly'
    || normalized === 'operations-readonly') {
    return normalized;
  }
  throw new Error(
    `Unsupported SAP_MCP_TOOL_PROFILE '${normalized}'. Use safe, development, diagnostic-readonly, legacy-full, development-workbench, business-readonly, or operations-readonly.`
  );
}

export function normalizeObjectName(value: string): string {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) {
    throw new SafeAbapError('POLICY_DENIED', 'policy', 'Object name is required.');
  }
  return normalized;
}

function parseHost(sapUrl?: string): string {
  if (!sapUrl) {
    return '';
  }
  try {
    return new URL(sapUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function csvSet(value?: string, normalize: (item: string) => string = item => item): Set<string> {
  return new Set(
    String(value || '')
      .split(',')
      .map(item => normalize(item.trim()))
      .filter(Boolean)
  );
}

function parseTtl(value?: string): number {
  const parsed = Number.parseInt(String(value || '900'), 10);
  if (!Number.isFinite(parsed) || parsed < 60 || parsed > 3600) {
    throw new Error('SAP_MCP_CHANGE_PLAN_TTL_SECONDS must be between 60 and 3600.');
  }
  return parsed * 1000;
}

function parseDebugAuthTtl(value?: string): number {
  const parsed = Number.parseInt(String(value || '900'), 10);
  if (!Number.isFinite(parsed) || parsed < 60 || parsed > 3600) {
    throw new Error('SAP_MCP_DEBUG_AUTH_TTL_SECONDS must be between 60 and 3600.');
  }
  return parsed * 1000;
}

function normalizeSapUser(value?: string): string {
  return String(value || '').trim().toUpperCase();
}

function parseBooleanFlag(value?: string): boolean {
  return String(value || '').trim().toLowerCase() === 'true';
}
