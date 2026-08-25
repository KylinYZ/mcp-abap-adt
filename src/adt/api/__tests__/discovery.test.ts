import { adtDiscovery } from '../discovery'

describe('adtDiscovery', () => {
  it('exposes collection accepted content types used by server-driven creation', async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        body: `<?xml version="1.0"?><app:service xmlns:app="http://www.w3.org/2007/app" xmlns:atom="http://www.w3.org/2005/Atom"><app:workspace><atom:title>DDIC</atom:title><app:collection href="/sap/bc/adt/ddic/structures"><atom:title>Structure</atom:title><app:accept>application/vnd.sap.adt.structures.v2+xml</app:accept><app:accept>text/html</app:accept><atom:category term="tablds" scheme="http://www.sap.com/wbobj/dictionary"/><adtcomp:templateLinks xmlns:adtcomp="http://www.sap.com/adt/compatibility"/></app:collection></app:workspace></app:service>`
      })
    }

    await expect(adtDiscovery(client as never)).resolves.toEqual([
      {
        title: 'DDIC',
        collection: [{
          href: '/sap/bc/adt/ddic/structures',
          acceptedContentTypes: ['application/vnd.sap.adt.structures.v2+xml', 'text/html'],
          category: { term: 'tablds', scheme: 'http://www.sap.com/wbobj/dictionary' },
          templateLinks: [],
          title: 'Structure'
        }]
      }
    ])
  })
})
