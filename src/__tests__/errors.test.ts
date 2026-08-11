import { SafeAbapError } from '../safe/errors';

describe('SafeAbapError', () => {
  it('returns a sanitized structured error with an actionable next step', () => {
    const response = new SafeAbapError(
      'TRANSPORT_INVALID',
      'transport',
      'Authorization: Basic dXNlcjpzZWNyZXQ='
    ).toResponse();

    expect(response).toMatchObject({
      status: 'error',
      error: {
        code: 'TRANSPORT_INVALID',
        stage: 'transport',
        message: 'Authorization=[REDACTED] [REDACTED]'
      }
    });
    expect((response.error as Record<string, unknown>).nextStep).toContain('existing unreleased transport');
    expect(JSON.stringify(response)).not.toContain('dXNlcjpzZWNyZXQ=');
  });
});
