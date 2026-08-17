import { ClassicTableInspector } from '../read/ClassicTableInspector';

const columns = [{
  name: 'MANDT',
  type: 'C',
  description: 'Client',
  keyAttribute: true,
  colType: 'CHAR',
  isKeyFigure: false,
  length: 3
}];

describe('ClassicTableInspector', () => {
  it('normalizes the table name and requests metadata with a generated zero-row query', async () => {
    const client = { tableContents: jest.fn().mockResolvedValue({ columns, values: [] }) };
    const inspector = new ClassicTableInspector(client as never);

    await expect(inspector.describe('t000')).resolves.toEqual({ tableName: 'T000', columns });
    expect(client.tableContents).toHaveBeenCalledWith('T000', 1, false, 'SELECT * FROM T000 WHERE 1 = 0');
  });

  it.each(['', 'T000 WHERE MANDT = 100', 'T000;DELETE', '../T000', '/BAD'])
  ('rejects invalid table identifier %p before SAP access', async tableName => {
    const client = { tableContents: jest.fn() };
    const inspector = new ClassicTableInspector(client as never);

    await expect(inspector.describe(tableName)).rejects.toThrow('tableName');
    expect(client.tableContents).not.toHaveBeenCalled();
  });

  it('fails closed if the data preview unexpectedly returns any business row', async () => {
    const client = { tableContents: jest.fn().mockResolvedValue({ columns, values: [{ MANDT: '100' }] }) };
    const inspector = new ClassicTableInspector(client as never);

    await expect(inspector.describe('T000')).rejects.toThrow('unexpected data rows');
  });
});
