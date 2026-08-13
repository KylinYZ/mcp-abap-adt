import type { Sm21RuntimeConfig } from './types.js';

type Environment = Record<string, string | undefined>;

export function sm21ConfigFromEnvironment(environment: Environment = process.env): Sm21RuntimeConfig {
  const timeZone = environment.SAP_MCP_SM21_TIMEZONE?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
  } catch {
    throw new Error(`SAP_MCP_SM21_TIMEZONE received '${timeZone}'; expected a valid IANA time-zone name.`);
  }
  return {
    timeZone,
    maxWindowHours: integer(environment, 'SAP_MCP_SM21_MAX_WINDOW_HOURS', 24, 1, 24),
    defaultPageSize: integer(environment, 'SAP_MCP_SM21_DEFAULT_PAGE_SIZE', 100, 1, 500),
    maxPageSize: integer(environment, 'SAP_MCP_SM21_MAX_PAGE_SIZE', 500, 1, 500)
  };
}

function integer(environment: Environment, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = environment[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} received '${raw}'; expected an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
