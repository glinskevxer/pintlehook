/**
 * A deterministic non cryptographic digest. Dedupe keys and journal checksums
 * need the same answer on every machine and in every process, which rules out
 * object identity and rules out anything seeded at start up.
 */

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;
const SEPARATOR = '|';
const ESCAPE = '~';
const NULL_MARKER = ESCAPE + 'n';

export function digestOf(text: string): string {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export type DigestPart = string | number | boolean | null | undefined;

/**
 * Join parts with a separator that cannot appear inside a part unescaped, so
 * that two different part lists can never produce the same joined key. The
 * escape character escapes itself first, which is the order that matters.
 */
export function digestKey(parts: readonly DigestPart[]): string {
  return parts
    .map((part) => {
      if (part === null || part === undefined) {
        return NULL_MARKER;
      }
      if (typeof part === 'string') {
        return part
          .split(ESCAPE)
          .join(ESCAPE + 'e')
          .split(SEPARATOR)
          .join(ESCAPE + 'p');
      }
      return String(part);
    })
    .join(SEPARATOR);
}

export function digestOfParts(parts: readonly DigestPart[]): string {
  return digestOf(digestKey(parts));
}

/** A stable digest of a record, ordered by key so two spellings agree. */
export function digestOfRecord(record: Readonly<Record<string, DigestPart>>): string {
  const keys = Object.keys(record).sort();
  const parts: DigestPart[] = [];
  for (const key of keys) {
    parts.push(key, record[key]);
  }
  return digestOfParts(parts);
}

/** Fold a list of digests into one, order sensitive. */
export function digestOfSequence(digests: readonly string[]): string {
  return digestOf(digests.join(SEPARATOR));
}

/** Fold a list of digests into one, order insensitive. */
export function digestOfSet(digests: readonly string[]): string {
  return digestOf([...digests].sort().join(SEPARATOR));
}
