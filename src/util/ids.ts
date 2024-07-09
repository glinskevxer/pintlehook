/**
 * Identifiers the brokerage actually prints on paper: motor carrier numbers,
 * USDOT numbers, and the referral codes that go on a fuel desk card. A referral
 * code has to survive being read aloud over a truck stop payphone, so it drops
 * the characters that sound alike and carries a check character.
 */

import { fail, ok, type Result } from './result.js';

/** Crockford style alphabet with I, L, O and U removed. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BODY_LENGTH = 6;

const CONFUSIONS: Record<string, string> = { I: '1', L: '1', O: '0', U: 'V' };

export function normalizeCodeInput(raw: string): string {
  let out = '';
  for (const character of raw.toUpperCase()) {
    if (character === '-' || character === ' ' || character === '_') {
      continue;
    }
    out += CONFUSIONS[character] ?? character;
  }
  return out;
}

function checkCharacter(body: string): string {
  let total = 0;
  for (let i = 0; i < body.length; i += 1) {
    const index = CODE_ALPHABET.indexOf(body[i] as string);
    if (index < 0) {
      throw new Error(`character outside the code alphabet: ${body[i] ?? ''}`);
    }
    total += index * (i + 2);
  }
  return CODE_ALPHABET[total % CODE_ALPHABET.length] as string;
}

/** Build a referral code from a body that the caller drew deterministically. */
export function mintReferralCode(body: string): Result<string> {
  const normalized = normalizeCodeInput(body);
  if (normalized.length !== CODE_BODY_LENGTH) {
    return fail(
      'referral_code_length',
      `a referral code body is ${CODE_BODY_LENGTH} characters, got ${normalized.length}`,
    );
  }
  for (const character of normalized) {
    if (!CODE_ALPHABET.includes(character)) {
      return fail('referral_code_alphabet', `character "${character}" is not in the code alphabet`);
    }
  }
  return ok(normalized + checkCharacter(normalized));
}

export function parseReferralCode(raw: string): Result<string> {
  const normalized = normalizeCodeInput(raw);
  if (normalized.length !== CODE_BODY_LENGTH + 1) {
    return fail('referral_code_length', `a referral code is ${CODE_BODY_LENGTH + 1} characters`);
  }
  const body = normalized.slice(0, CODE_BODY_LENGTH);
  const given = normalized.slice(CODE_BODY_LENGTH);
  for (const character of normalized) {
    if (!CODE_ALPHABET.includes(character)) {
      return fail('referral_code_alphabet', `character "${character}" is not in the code alphabet`);
    }
  }
  if (checkCharacter(body) !== given) {
    return fail('referral_code_check', `check character does not match for "${raw}"`);
  }
  return ok(normalized);
}

export function formatReferralCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/** Motor carrier authority number, printed as MC-123456. */
export function parseMotorCarrierNumber(raw: string): Result<string> {
  const trimmed = raw
    .trim()
    .toUpperCase()
    .replace(/^MC[-\s]?/, '');
  if (!/^\d{4,8}$/.test(trimmed)) {
    return fail('mc_number_shape', `"${raw}" is not a motor carrier number`);
  }
  return ok(`MC${String(Number(trimmed))}`);
}

/** USDOT number, plain digits, no leading zeros once normalised. */
export function parseDotNumber(raw: string): Result<string> {
  const trimmed = raw
    .trim()
    .toUpperCase()
    .replace(/^(USDOT|DOT)[-\s]?/, '');
  if (!/^\d{4,9}$/.test(trimmed)) {
    return fail('dot_number_shape', `"${raw}" is not a USDOT number`);
  }
  return ok(String(Number(trimmed)));
}

/** A stable surrogate key built from a prefix and a monotonically drawn number. */
export function surrogateId(prefix: string, sequence: number): string {
  if (!/^[a-z]{2,6}$/.test(prefix)) {
    throw new Error(`surrogate prefix must be two to six lower case letters, got "${prefix}"`);
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`surrogate sequence must be a non negative integer, got ${sequence}`);
  }
  return `${prefix}_${String(sequence).padStart(8, '0')}`;
}

export function parseSurrogateId(value: string): Result<{ prefix: string; sequence: number }> {
  const match = /^([a-z]{2,6})_(\d{8})$/.exec(value);
  if (match === null) {
    return fail('surrogate_shape', `"${value}" is not a surrogate identifier`);
  }
  return ok({ prefix: match[1] as string, sequence: Number(match[2]) });
}

export function codeAlphabet(): string {
  return CODE_ALPHABET;
}
