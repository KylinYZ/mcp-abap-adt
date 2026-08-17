import { dumps } from '../adt/index.js';

describe('ADT runtime dump feed parsing', () => {
  it('preserves optional entry timestamps without changing the existing dump fields', async () => {
    const request = jest.fn().mockResolvedValue({
      body: `<?xml version="1.0" encoding="utf-8"?>
        <atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
          <atom:title>Runtime Errors</atom:title>
          <atom:updated>2026-08-17T08:30:00Z</atom:updated>
          <atom:link href="/sap/bc/adt/runtime/dumps" />
          <atom:entry>
            <atom:id>dump-1</atom:id>
            <atom:author><atom:name>DEV_USER</atom:name></atom:author>
            <atom:published>2026-08-17T08:00:00Z</atom:published>
            <atom:updated>2026-08-17T08:05:00Z</atom:updated>
            <atom:category term="MESSAGE_TYPE_X" label="ABAP runtime error" />
            <atom:summary type="text">Runtime error summary</atom:summary>
          </atom:entry>
        </atom:feed>`
    });

    const result = await dumps({ request } as never);

    expect(result.dumps[0]).toMatchObject({
      id: 'dump-1',
      author: 'DEV_USER',
      text: 'Runtime error summary',
      type: 'text',
      published: new Date('2026-08-17T08:00:00Z'),
      updated: new Date('2026-08-17T08:05:00Z')
    });
  });
});
