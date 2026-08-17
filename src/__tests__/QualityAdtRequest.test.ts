import { createAtcRun, runUnitTest } from '../adt/index.js';

describe('quality-check ADT request shapes', () => {
  it('sends multiple ABAP Unit objects in one bounded request with a per-call timeout', async () => {
    const request = jest.fn().mockResolvedValue({
      body: '<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit" />'
    });

    await runUnitTest({ request } as never, ['/object/one', '/object/two'], {
      harmless: true, dangerous: false, critical: false, short: true, medium: false, long: false
    }, 30_000);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/sap/bc/adt/abapunit/testruns');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', timeout: 30_000 });
    expect(request.mock.calls[0][1].body).toContain('adtcore:uri="/object/one"');
    expect(request.mock.calls[0][1].body).toContain('adtcore:uri="/object/two"');
  });

  it('sends multiple ATC objects in one bounded request with a per-call timeout', async () => {
    const request = jest.fn().mockResolvedValue({
      body: [
        '<worklistRun>',
        '<worklistId>RUN-1</worklistId>',
        '<worklistTimestamp>2026-08-17T00:00:00Z</worklistTimestamp>',
        '<infos></infos>',
        '</worklistRun>'
      ].join('')
    });

    await createAtcRun({ request } as never, 'DEFAULT', ['/object/one', '/object/two'], 100, 45_000);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toContain('worklistId=DEFAULT');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', timeout: 45_000 });
    expect(request.mock.calls[0][1].body).toContain('adtcore:uri="/object/one"');
    expect(request.mock.calls[0][1].body).toContain('adtcore:uri="/object/two"');
  });
});
