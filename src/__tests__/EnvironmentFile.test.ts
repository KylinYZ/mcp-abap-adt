import path from 'path';
import { selectEnvironmentFile } from '../config/EnvironmentFile';

describe('environment file selection', () => {
  it('keeps the adjacent .env as the backward-compatible default', () => {
    expect(selectEnvironmentFile(undefined, '/workspace', '/server/.env')).toEqual({
      path: '/server/.env',
      explicit: false
    });
  });

  it('resolves a relative configured file from the process working directory', () => {
    expect(selectEnvironmentFile('config/sap-dev.env', '/workspace', '/server/.env')).toEqual({
      path: path.resolve('/workspace', 'config/sap-dev.env'),
      explicit: true
    });
  });

  it('preserves an absolute configured file', () => {
    const configuredPath = path.resolve('/sap-config', 'sap-prd.env');
    expect(selectEnvironmentFile(configuredPath, '/workspace', '/server/.env')).toEqual({
      path: configuredPath,
      explicit: true
    });
  });
});
