import { createCipheriv } from "node:crypto";

export const DEFAULT_AES_KEY = "SA!nUNPZ5o!OSV&B";
export const DEFAULT_AES_IV = "SA!nwwwZ5o!OSV&B";

/** Matches the GitCode web login's CryptoJS AES-CBC/PKCS7 encoding. */
export function encryptGitCodePassword(password: string, key = DEFAULT_AES_KEY, iv = DEFAULT_AES_IV): string {
  const keyBytes = Buffer.from(key, "utf8");
  const ivBytes = Buffer.from(iv, "utf8");
  if (![16, 24, 32].includes(keyBytes.length) || ivBytes.length !== 16) {
    throw new Error("GitCode AES key must be 16/24/32 bytes and IV must be 16 bytes");
  }
  const cipher = createCipheriv(`aes-${keyBytes.length * 8}-cbc`, keyBytes, ivBytes);
  return Buffer.concat([cipher.update(password, "utf8"), cipher.final()]).toString("base64");
}
