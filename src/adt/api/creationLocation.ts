import { adtException } from '../AdtException'
import type { HeaderValue, HttpClientResponse } from '../AdtHTTP'

const LOCATION_BASE = 'https://adt.invalid/'

export function requireCanonicalCreationLocation(
  response: HttpClientResponse,
  expectedPath: string,
  operation: string
): string {
  const location = singleHeader(response.headers.location ?? response.headers.Location)
  const actualPath = normalizeCreationLocationPath(location)
  const canonicalExpectedPath = normalizeCreationLocationPath(expectedPath)
  if (response.status !== 201 || !location || actualPath !== canonicalExpectedPath) {
    const receivedPath = actualPath || (location ? '[invalid]' : '[missing]')
    throw adtException(
      `${operation} did not return HTTP 201 with the canonical Location header `
      + `(status ${response.status}; Location path ${receivedPath}).`
    )
  }
  return location
}

export function normalizeCreationLocationPath(value: string): string {
  const candidate = String(value || '').trim()
  if (!candidate) return ''
  try {
    // SAP may return either an absolute Location or an HTTP relative-reference;
    // only the normalized ADT pathname participates in ownership verification.
    const parsed = new URL(candidate, LOCATION_BASE)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.pathname.replace(/\/+$/, '').toLowerCase()
  } catch {
    return ''
  }
}

function singleHeader(value: HeaderValue | undefined): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length === 1) return value[0]
  return ''
}
