/**
 * ULID — Universally Unique Lexicographically Sortable Identifier.
 * Pure TypeScript, zero dependencies, browser + node.
 *
 * Why ULIDs here (and not UUIDv4 or autoincrement):
 * - **Stable client-generated ID** — every record and every journal op is
 *   identified before it ever touches the network, which is what makes
 *   offline creates / replays idempotent (SPEC pitfall: "non-idempotent
 *   replay → duplicates").
 * - **Lexicographically time-sortable** — the first 10 chars encode the
 *   creation millisecond, so sorting by ID is a stable, human-explainable
 *   display order without trusting wall-clocks for *conflict* ordering
 *   (conflict ordering is Yjs's job, never timestamps).
 * - **Monotonic within a millisecond** — two ops generated in the same ms on
 *   the same client still sort in generation order (journal replay-order
 *   proof relies on this).
 *
 * Format: 26 chars of Crockford base32 — 10 time chars (48-bit ms) +
 * 16 random chars (80 bits).
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32
const TIME_LEN = 10
const RANDOM_LEN = 16

let lastTime = -1
// last random part kept as 16 base32 digit values (0..31) for monotonic bump
let lastRandom: number[] = []

function randomDigits(): number[] {
  const out = new Array<number>(RANDOM_LEN)
  const cryptoObj: Crypto | undefined =
    typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(RANDOM_LEN)
    cryptoObj.getRandomValues(bytes)
    for (let i = 0; i < RANDOM_LEN; i++) out[i] = bytes[i] % 32
  } else {
    for (let i = 0; i < RANDOM_LEN; i++) out[i] = Math.floor(Math.random() * 32)
  }
  return out
}

function encodeTime(now: number): string {
  let t = now
  const chars = new Array<string>(TIME_LEN)
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    chars[i] = ENCODING[t % 32]
    t = Math.floor(t / 32)
  }
  return chars.join('')
}

function encodeDigits(digits: number[]): string {
  let s = ''
  for (let i = 0; i < digits.length; i++) s += ENCODING[digits[i]]
  return s
}

/** Increment a base32 digit array by one (carries; wraps only on overflow). */
function incrementDigits(digits: number[]): number[] {
  const next = digits.slice()
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 31) {
      next[i]++
      return next
    }
    next[i] = 0
  }
  // 80-bit overflow within one millisecond: practically impossible; start over.
  return randomDigits()
}

/** Generate a monotonic ULID. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = incrementDigits(lastRandom)
  } else {
    lastTime = now
    lastRandom = randomDigits()
  }
  return encodeTime(now) + encodeDigits(lastRandom)
}

/** True if `s` looks like a ULID (26 Crockford base32 chars). */
export function isUlid(s: string): boolean {
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(s)
}
