import { configureLogLevel, createLogger } from '../lib/logger';

describe('logger', () => {
  const writeSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

  beforeEach(() => {
    writeSpy.mockClear();
    configureLogLevel('warn');
  });

  afterAll(() => {
    writeSpy.mockRestore();
  });

  it('does not serialize or write disabled info and debug logs', () => {
    const stringifySpy = jest.spyOn(JSON, 'stringify');
    const timestampSpy = jest.spyOn(Date.prototype, 'toISOString');
    const logger = createLogger('test');

    logger.info('hidden');
    logger.debug('hidden');

    expect(timestampSpy).not.toHaveBeenCalled();
    expect(stringifySpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    timestampSpy.mockRestore();
    stringifySpy.mockRestore();
  });

  it('writes warn and error logs to stderr by default', () => {
    const logger = createLogger('test');

    logger.warn('warning');
    logger.error('failure');

    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it.each(['info', 'debug'] as const)('enables %s logs when configured', level => {
    configureLogLevel(level);
    const logger = createLogger('test');

    logger[level]('visible', { correlationId: 'plan-1' });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(String(writeSpy.mock.calls[0][0])).toContain('plan-1');
  });
});
