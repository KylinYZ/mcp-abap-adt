import { ADTClient } from '../adt/index.js';

const expectedSurface = require('./fixtures/adt-client-surface.json') as string[];

describe('embedded ADTClient public surface', () => {
  it('keeps the reviewed 145 instance callables', () => {
    const descriptors = Object.getOwnPropertyDescriptors(ADTClient.prototype) as Record<string, PropertyDescriptor>;
    const prototypeMethods = Object.entries(descriptors)
      .filter(([name, descriptor]) => name !== 'constructor'
        && name !== 'createHttp'
        && typeof descriptor.value === 'function')
      .map(([name]) => name);
    const client = new ADTClient('https://example.invalid', 'USER', 'PASSWORD', '100', 'EN');
    const callableProperties = Object.keys(client)
      .filter(name => ['hasTransportConfig', 'isProposalMessage'].includes(name)
        && typeof (client as unknown as Record<string, unknown>)[name] === 'function');

    expect([...prototypeMethods, ...callableProperties].sort()).toEqual(expectedSurface);
    expect(expectedSurface).toHaveLength(145);
  });

  it('keeps the four reviewed static helpers', () => {
    expect([
      'classIncludes',
      'isMainInclude',
      'mainInclude',
      'textElementsUrl'
    ].filter(name => typeof (ADTClient as unknown as Record<string, unknown>)[name] === 'function'))
      .toHaveLength(4);
  });
});
