import { CFG } from './config'

const KEY_PATTERN = /user_[a-zA-Z0-9_-]+/

function extractKey(value: string | undefined): string | null {
  if (!value) return null
  const match = value.match(KEY_PATTERN)
  return match ? match[0] : null
}

export function getApiKey(headers: Record<string, string | undefined>): string | null {
  const auth = headers['authorization'] || headers['Authorization'] || ''
  if (auth.startsWith('Bearer ')) {
    const key = extractKey(auth.slice(7))
    if (key) return key
  }
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || ''
  const keyFromHeader = extractKey(xKey)
  if (keyFromHeader) return keyFromHeader

  return extractKey(CFG.apiKey)
}

