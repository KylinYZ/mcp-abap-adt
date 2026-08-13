import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { sm21ConfigFromEnvironment } from '../sm21/config';
import { parseSm21Request } from '../sm21/request';

const config = { timeZone: 'Asia/Shanghai', maxWindowHours: 24, defaultPageSize: 100, maxPageSize: 500 };

describe('SM21 request boundaries', () => {
  it('parses a bounded request in the configured SAP time zone', () => {
    expect(parseSm21Request({
      fromDateTime: '2026-08-13T00:00:00Z', toDateTime: '2026-08-13T01:00:00Z',
      users: ['dev_user', 'DEV_USER'], severity: 'ERROR', pageSize: 20, offset: 4
    }, config)).toEqual(expect.objectContaining({
      from: '20260813080000', to: '20260813090000', users: ['DEV_USER'], severity: 'ERROR', pageSize: 20, offset: 4
    }));
  });

  it.each([
    [{ fromDateTime: 'invalid', toDateTime: '2026-08-13T01:00:00Z' }],
    [{ fromDateTime: '2026-08-13T02:00:00Z', toDateTime: '2026-08-13T01:00:00Z' }],
    [{ fromDateTime: '2026-08-13T00:00:00Z', toDateTime: '2026-08-14T01:00:01Z' }],
    [{ fromDateTime: '2026-08-13T00:00:00Z', toDateTime: '2026-08-13T01:00:00Z', pageSize: 501 }],
    [{ fromDateTime: '2026-08-13T00:00:00Z', toDateTime: '2026-08-13T01:00:00Z', instances: Array(21).fill('APP') }]
  ])('rejects invalid or unbounded input', argumentsValue => {
    expect(() => parseSm21Request(argumentsValue, config)).toThrow(McpError);
  });

  it('validates SM21 runtime configuration', () => {
    expect(sm21ConfigFromEnvironment({})).toEqual({ timeZone: 'UTC', maxWindowHours: 24, defaultPageSize: 100, maxPageSize: 500 });
    expect(() => sm21ConfigFromEnvironment({ SAP_MCP_SM21_MAX_WINDOW_HOURS: '25' })).toThrow('SAP_MCP_SM21_MAX_WINDOW_HOURS');
    expect(() => sm21ConfigFromEnvironment({ SAP_MCP_SM21_TIMEZONE: 'not-a-timezone' })).toThrow('SAP_MCP_SM21_TIMEZONE');
  });
});
