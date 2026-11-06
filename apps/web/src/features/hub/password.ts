/** Generated passwords for published pages: easy to read aloud and type. */

/** Letters and digits without the ones read as each other (0/O/o, 1/l/I). */
export const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export const GENERATED_LENGTH = 12;

type RandomFill = (bytes: Uint8Array) => Uint8Array;
const browserRandom: RandomFill = bytes => crypto.getRandomValues(bytes);

/**
 * `length` characters of PASSWORD_ALPHABET from a cryptographic source.
 * Bytes past the last whole multiple of the alphabet are thrown away, so every
 * character is equally likely.
 */
export function generatePassword(length = GENERATED_LENGTH, random: RandomFill = browserRandom): string {
  const size = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % size);
  let out = "";
  while (out.length < length) {
    for (const byte of random(new Uint8Array(length * 2))) {
      if (byte >= limit) continue;
      out += PASSWORD_ALPHABET[byte % size];
      if (out.length === length) break;
    }
  }
  return out;
}
