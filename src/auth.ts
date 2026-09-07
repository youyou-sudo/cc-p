import { CFG } from './config'

export const KEY_PATTERN = /^user_[a-zA-Z0-9_-]+$/

const LOOSE_KEY_PATTERN = /user_[a-zA-Z0-9_-]+/

function extractKey(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return KEY_PATTERN.test(trimmed) ? trimmed : null
}

function extractLooseKey(value: string | undefined): string | null {
  if (!value) return null
  const match = value.match(LOOSE_KEY_PATTERN)
  return match ? match[0] : null
}

export function getApiKey(headers: Record<string, string | undefined>): string | null {
  const auth = headers['authorization'] || headers['Authorization'] || ''
  if (auth.startsWith('Bearer ')) {
    const presented = auth.slice(7).trim()
    if (presented) {
      return extractKey(presented)
    }
  }
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || ''
  const keyFromHeader = extractKey(xKey)
  if (keyFromHeader) return keyFromHeader

  return extractLooseKey(CFG.apiKey)
}

export function keyFormatError(headers: Record<string, string | undefined>): string | null {
  const auth = headers['authorization'] || headers['Authorization'] || ''
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || ''
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (xKey || '').trim()
  if (!presented) return null
  if (!KEY_PATTERN.test(presented)) {
    return 'Invalid API key: expected "user_" followed by base64url characters (e.g. user_abc123), got "' +
      presented.slice(0, 12) + (presented.length > 12 ? '…"' : '"')
  }
  return null
}

export function authErrorMessage(headers: Record<string, string | undefined>): string {
  const format = keyFormatError(headers)
  if (format) return format
  return CFG.apiKey
    ? 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header, or set CC_API_KEY.'
    : 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header'
}
