/**
 * At-rest encryption for message payloads (sprint 10 T3, spec §10.7).
 *
 * Design choice (spike record — see docs/encryption-at-rest.md): field-level
 * AES-256-GCM over SQLCipher. Pure Node (`node:crypto`, zero native deps —
 * no node-gyp on win32/arm), keeps the SQLite file format and the additive
 * migration story (existing deployments need no dump/restore), and scopes
 * encryption to the payload column exactly as the sprint-6 decision recorded:
 * the server must still read everything else (dashboard previews, reads
 * aggregates, wake prompts).
 *
 * Envelope: the stored payload cell is either plaintext JSON (legacy rows,
 * or any deployment without a key) or an `abenc1:`-prefixed envelope —
 * self-describing, so a mixed database (rows written before a key was set)
 * reads transparently:
 *
 *   abenc1:<iv-base64>.<tag-base64>.<ciphertext-base64>
 *
 * Key derivation: scrypt(AB_ENCRYPTION_KEY, fixed app salt, 32 bytes).
 * A fixed salt is acceptable here: the key material is a high-entropy secret
 * the operator controls, and the salt's purpose is only to stop rainbow
 * reuse of the raw env value across unrelated deployments.
 *
 * No key (`enabled: false`): plaintext in, plaintext out; the current
 * transport-only default is byte-for-byte unchanged. Reading an envelope
 * WITHOUT the key fails with an explicit message instead of a JSON.parse
 * crash (operators who strip the key from a previously-encrypted DB get a
 * clear signal, not a mystery 500).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Envelope prefix marking a payload cell as encrypted at rest. */
export const AB_ENC_MAGIC = 'abenc1:';

export interface PayloadCipher {
  readonly enabled: boolean;
  encrypt(plaintext: string): string;
  decrypt(stored: string): string;
}

const KEY_SALT = 'agentboard-payload-at-rest-v1';
const IV_BYTES = 12; // AES-GCM recommended IV size
const KEY_BYTES = 32; // AES-256

export function derivePayloadKey(secret: string): Buffer {
  return scryptSync(secret, KEY_SALT, KEY_BYTES);
}

/**
 * Build the payload cipher for a deployment. Pass `undefined` (or the
 * `AB_ENCRYPTION_KEY` env value) for the transport-only default.
 */
export function makePayloadCipher(secret: string | undefined): PayloadCipher {
  if (!secret || secret.length === 0) {
    return {
      enabled: false,
      encrypt: (plaintext) => plaintext,
      decrypt: (stored) => {
        if (!stored.startsWith(AB_ENC_MAGIC)) return stored;
        throw new Error(
          `payload is encrypted at rest (${AB_ENC_MAGIC} envelope) — this database was written with AB_ENCRYPTION_KEY set; restart the server with the same key to read it`,
        );
      },
    };
  }
  const key = derivePayloadKey(secret);
  return {
    enabled: true,
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${AB_ENC_MAGIC}${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
    },
    decrypt(stored) {
      if (!stored.startsWith(AB_ENC_MAGIC)) return stored; // legacy/plaintext row
      const rest = stored.slice(AB_ENC_MAGIC.length);
      const dot = rest.indexOf('.');
      if (dot === -1) throw new Error(`invalid ${AB_ENC_MAGIC} envelope — corrupt payload cell`);
      const ivB64 = rest.slice(0, dot);
      const tail = rest.slice(dot + 1);
      const dot2 = tail.indexOf('.');
      if (dot2 === -1) throw new Error(`invalid ${AB_ENC_MAGIC} envelope — corrupt payload cell`);
      const tagB64 = tail.slice(0, dot2);
      const ctB64 = tail.slice(dot2 + 1);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      // GCM authentication failure (wrong key / tampered cell) surfaces here.
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}

/** Convenience for index.ts: read the key from the environment once. */
export function payloadCipherFromEnv(): PayloadCipher {
  return makePayloadCipher(process.env.AB_ENCRYPTION_KEY);
}