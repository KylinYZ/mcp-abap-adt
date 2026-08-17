import { SystemInspector } from '../read/SystemInspector';

const configuredTarget = {
  host: 'dev.example.invalid',
  client: '100',
  toolProfile: 'development',
  systemRole: 'DEV'
};

describe('SystemInspector', () => {
  it('keeps configured identity separate from independently confirmed SAP capabilities', async () => {
    const client = {
      adtDiscovery: jest.fn().mockResolvedValue([
        { title: 'ABAP Development Tools', collection: [{ href: '/sap/bc/adt/repository', templateLinks: [] }] }
      ]),
      feeds: jest.fn().mockResolvedValue([{ title: 'Runtime Errors', href: '/sap/bc/adt/runtime/dumps' }]),
      objectTypes: jest.fn().mockResolvedValue([
        { name: 'Class', description: 'Class', type: 'CLAS/OC', usedBy: ['ADT'] }
      ])
    };

    const result = await new SystemInspector(client, configuredTarget).inspect();

    expect(result).toEqual({
      configuredTarget,
      sapConnectionVerified: true,
      capabilities: {
        adtDiscovery: { status: 'CONFIRMED', workspaceCount: 1, collectionCount: 1 },
        feeds: { status: 'CONFIRMED', feedCount: 1 },
        objectTypes: { status: 'CONFIRMED', objectTypeCount: 1 }
      }
    });
  });

  it('preserves partial success and emits only bounded error categories', async () => {
    const unavailable = Object.assign(new Error('SECRET 404 RESPONSE BODY'), { response: { status: 404 } });
    const timedOut = Object.assign(new Error('SECRET TARGET URL'), { code: 'ETIMEDOUT' });
    const client = {
      adtDiscovery: jest.fn().mockResolvedValue([]),
      feeds: jest.fn().mockRejectedValue(unavailable),
      objectTypes: jest.fn().mockRejectedValue(timedOut)
    };

    const result = await new SystemInspector(client, configuredTarget).inspect();

    expect(result).toMatchObject({
      sapConnectionVerified: true,
      capabilities: {
        adtDiscovery: { status: 'CONFIRMED', workspaceCount: 0, collectionCount: 0 },
        feeds: { status: 'UNAVAILABLE', reasonCategory: 'NOT_SUPPORTED', httpStatus: 404 },
        objectTypes: { status: 'FAILED', reasonCategory: 'TIMEOUT' }
      }
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('does not infer a release from titles and reports explicit version fields only', async () => {
    const client = {
      adtDiscovery: jest.fn().mockResolvedValue([
        { title: 'SAP NetWeaver 7.50', collection: [], release: '757', product: 'S/4HANA' }
      ]),
      feeds: jest.fn().mockResolvedValue([]),
      objectTypes: jest.fn().mockResolvedValue([])
    };

    const result = await new SystemInspector(client, configuredTarget).inspect();

    expect(result.systemVersion).toEqual({ release: '757', product: 'S/4HANA' });
    expect(JSON.stringify(result.systemVersion)).not.toContain('7.50');
  });
});
