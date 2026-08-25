import { validateNewObject } from '../objectcreator'

describe('generic object creation validation', () => {
  it('accepts an acknowledged empty validation response', async () => {
    const client = { request: jest.fn().mockResolvedValue({ status: 200, body: '' }) }

    await expect(validateNewObject(client as never, {
      objtype: 'MSAG/N', objname: 'ZVMSG', description: 'Messages', packagename: 'Z001'
    })).resolves.toEqual({ success: true })
  })
})
