import type { TransportInfo, TransportRequest } from '../../adt/index.js'
import { SafeAbapError } from '../errors.js'

export function assertTargetAbsent(
  results: Array<{ 'adtcore:name': string; 'adtcore:type': string }>,
  name: string,
  adtType: string
): void {
  const normalizedName = name.toUpperCase()
  if (results.some(item => item['adtcore:name'].toUpperCase() === normalizedName && item['adtcore:type'].toUpperCase() === adtType)) {
    throw new SafeAbapError('OBJECT_ALREADY_EXISTS', 'absence', `${normalizedName} already exists.`)
  }
}

export function assertValidation(result: { success: boolean; SEVERITY?: string; SHORT_TEXT?: string }, name: string): void {
  if (!result.success || ['E', 'ERROR'].includes(String(result.SEVERITY || '').toUpperCase())) {
    throw new SafeAbapError('OBJECT_VALIDATION_FAILED', 'validation', result.SHORT_TEXT || `SAP rejected ${name}.`)
  }
}

export function assertTransportAvailable(info: TransportInfo, details: TransportRequest, transportRequest: string): void {
  const available = new Set([
    ...(info.TRANSPORTS || []).map(item => item.TRKORR),
    info.LOCKS?.HEADER?.TRKORR,
    ...(info.LOCKS?.TASKS || []).map(item => item.TRKORR)
  ].filter(Boolean).map(item => String(item).toUpperCase()))
  if (!available.has(transportRequest)) {
    throw new SafeAbapError('TRANSPORT_INVALID', 'transport', `Transport ${transportRequest} is not available for this package.`)
  }
  const status = String((details as unknown as Record<string, unknown>)['tm:status'] || '').toUpperCase()
  if (status === 'R' || status.includes('RELEASE')) {
    throw new SafeAbapError('TRANSPORT_INVALID', 'transport', `Transport ${transportRequest} is already released.`)
  }
}

export function requiredString(request: Record<string, unknown>, key: string, maximum: number): string {
  const value = String(request[key] || '').trim()
  if (!value || value.length > maximum || /[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'input', `${key} is required and must be one bounded line.`)
  }
  return value
}

export function controlledResponsible(candidate: unknown, fallback: string): string {
  const value = String(candidate || '').trim()
  return !value || value.toUpperCase() === 'SAP' ? fallback : value
}

export function sameControlledMasterSystem(actual: unknown, expected: string): boolean {
  const left = String(actual || '').trim().toUpperCase()
  const right = String(expected || '').trim().toUpperCase()
  if (right === 'SAP') return /^[A-Z0-9]{3}$/.test(left) && left !== 'SAP'
  return left === right
}

export function repositoryName(request: Record<string, unknown>, key: string, maximum: number): string {
  const value = requiredString(request, key, maximum).toUpperCase()
  if (!/^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'input', `${key} is not a valid ABAP repository name.`)
  }
  return value
}

export function assertNoCheckErrors(messages: Array<{ severity: string; text: string }>, stage: string): void {
  const failures = messages.filter(message => /[EAX]/i.test(message.severity))
  if (failures.length > 0) {
    throw new SafeAbapError('SYNTAX_CHECK_FAILED', stage, failures.map(message => message.text).join('; '))
  }
}

export function assertActivation(result: { success: boolean; messages: Array<{ shortText?: string }> }, stage: string): void {
  if (!result.success) {
    throw new SafeAbapError('ACTIVATION_FAILED', stage, result.messages.map(message => message.shortText).filter(Boolean).join('; ') || 'SAP activation failed.')
  }
}
