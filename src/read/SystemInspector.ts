type CapabilityStatus = 'CONFIRMED' | 'UNAVAILABLE' | 'FAILED';

interface SystemInspectionClient {
  adtDiscovery(): Promise<unknown>;
  feeds(): Promise<unknown>;
  objectTypes(): Promise<unknown>;
}

export interface ConfiguredTargetIdentity {
  host: string;
  client: string;
  toolProfile: string;
  systemRole: string;
}

interface CapabilityFailure {
  status: Exclude<CapabilityStatus, 'CONFIRMED'>;
  reasonCategory: 'AUTHENTICATION' | 'AUTHORIZATION' | 'NETWORK' | 'NOT_SUPPORTED' | 'REMOTE_ERROR' | 'TIMEOUT';
  summary: string;
  httpStatus?: number;
}

interface CapabilitySuccess extends Record<string, unknown> {
  status: 'CONFIRMED';
}

interface CapabilityCapture {
  result: CapabilitySuccess | CapabilityFailure;
  raw?: unknown;
}

export interface SystemInspectionResult {
  configuredTarget: ConfiguredTargetIdentity;
  sapConnectionVerified: boolean;
  capabilities: {
    adtDiscovery: CapabilitySuccess | CapabilityFailure;
    feeds: CapabilitySuccess | CapabilityFailure;
    objectTypes: CapabilitySuccess | CapabilityFailure;
  };
  systemVersion?: {
    release?: string;
    product?: string;
    productVersion?: string;
  };
}

export class SystemInspector {
  constructor(
    private readonly client: SystemInspectionClient,
    private readonly configuredTarget: ConfiguredTargetIdentity
  ) {}

  async inspect(): Promise<SystemInspectionResult> {
    // Keep probes sequential so one high-level read respects the single SAP execution budget.
    const discovery = await captureCapability(
      () => this.client.adtDiscovery(),
      value => {
        const workspaces = arrayValue(value);
        return {
          workspaceCount: workspaces.length,
          collectionCount: workspaces.reduce<number>((count, workspace) => (
            count + arrayValue(recordValue(workspace)?.collection).length
          ), 0)
        };
      }
    );
    const feeds = await captureCapability(
      () => this.client.feeds(),
      value => ({ feedCount: arrayValue(value).length })
    );
    const objectTypes = await captureCapability(
      () => this.client.objectTypes(),
      value => ({ objectTypeCount: arrayValue(value).length })
    );

    const capabilities = {
      adtDiscovery: discovery.result,
      feeds: feeds.result,
      objectTypes: objectTypes.result
    };
    const systemVersion = explicitSystemVersion([discovery.raw, feeds.raw, objectTypes.raw]);
    const result: SystemInspectionResult = {
      configuredTarget: { ...this.configuredTarget },
      sapConnectionVerified: Object.values(capabilities).some(capability => capability.status === 'CONFIRMED'),
      capabilities
    };
    if (systemVersion) result.systemVersion = systemVersion;
    return result;
  }
}

async function captureCapability(
  probe: () => Promise<unknown>,
  summarize: (value: unknown) => Record<string, unknown>
): Promise<CapabilityCapture> {
  try {
    const raw = await probe();
    return { result: { status: 'CONFIRMED', ...summarize(raw) }, raw };
  } catch (error) {
    return { result: boundedFailure(error) };
  }
}

function boundedFailure(error: unknown): CapabilityFailure {
  const record = recordValue(error);
  const response = recordValue(record?.response);
  const statusValue = response?.status;
  const httpStatus = typeof statusValue === 'number' && Number.isInteger(statusValue) ? statusValue : undefined;
  const code = String(record?.code || '').toUpperCase();

  if (httpStatus === 404 || httpStatus === 405 || httpStatus === 501) {
    return { status: 'UNAVAILABLE', reasonCategory: 'NOT_SUPPORTED', summary: 'SAP did not expose this capability.', httpStatus };
  }
  if (httpStatus === 401) {
    return { status: 'FAILED', reasonCategory: 'AUTHENTICATION', summary: 'SAP rejected authentication.', httpStatus };
  }
  if (httpStatus === 403) {
    return { status: 'FAILED', reasonCategory: 'AUTHORIZATION', summary: 'SAP rejected authorization.', httpStatus };
  }
  if (code.includes('TIMEOUT') || code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    return { status: 'FAILED', reasonCategory: 'TIMEOUT', summary: 'The SAP capability probe timed out.' };
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { status: 'FAILED', reasonCategory: 'NETWORK', summary: 'The SAP endpoint was not reachable.' };
  }
  return {
    status: 'FAILED',
    reasonCategory: 'REMOTE_ERROR',
    summary: 'The SAP capability probe failed.',
    ...(httpStatus === undefined ? {} : { httpStatus })
  };
}

function explicitSystemVersion(values: unknown[]): SystemInspectionResult['systemVersion'] | undefined {
  const evidence: NonNullable<SystemInspectionResult['systemVersion']> = {};
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || Object.keys(evidence).length === 3) return;
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach(item => visit(item, depth + 1));
      return;
    }
    const record = recordValue(value);
    if (!record) return;
    for (const key of ['release', 'product', 'productVersion'] as const) {
      const candidate = record[key];
      if (evidence[key] === undefined && typeof candidate === 'string' && candidate.trim() && candidate.length <= 128) {
        evidence[key] = candidate.trim();
      }
    }
    Object.values(record).slice(0, 100).forEach(item => visit(item, depth + 1));
  };
  values.forEach(value => visit(value, 0));
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, any> : undefined;
}
