/**
 * `.wopsave` pack/unpack — AES-256-GCM. Key from `WOP_SAVE_KEY` only (never to clients).
 *
 * Layout: magic "WOPS" (4) | version u16 LE | iv (12) | ciphertext | authTag (16)
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAGIC = Buffer.from("WOPS", "ascii");
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SaveKeyMissingError extends Error {
  constructor() {
    super("WOP_SAVE_KEY is not configured");
    this.name = "SaveKeyMissingError";
  }
}

export class SaveDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveDecryptError";
  }
}

/** Resolve 32-byte AES key from env. Accepts raw 32-byte base64 or any passphrase (SHA-256). */
export function resolveSaveKey(): Buffer {
  const raw = process.env.WOP_SAVE_KEY?.trim();
  if (!raw) throw new SaveKeyMissingError();
  try {
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 32) return b64;
  } catch {
    /* fall through */
  }
  // Hex 64 chars
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

export function hasSaveKey(): boolean {
  return Boolean(process.env.WOP_SAVE_KEY?.trim());
}

export function encryptSaveDocument(doc: unknown): Buffer {
  const key = resolveSaveKey();
  const plaintext = Buffer.from(JSON.stringify(doc), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const version = Buffer.alloc(2);
  version.writeUInt16LE(FORMAT_VERSION, 0);
  return Buffer.concat([MAGIC, version, iv, ciphertext, tag]);
}

export function decryptSaveBlob(blob: Buffer): unknown {
  const key = resolveSaveKey();
  if (blob.length < 4 + 2 + IV_BYTES + TAG_BYTES) {
    throw new SaveDecryptError("存档文件过短");
  }
  if (!blob.subarray(0, 4).equals(MAGIC)) {
    throw new SaveDecryptError("不是有效的 .wopsave 文件");
  }
  const version = blob.readUInt16LE(4);
  if (version !== FORMAT_VERSION) {
    throw new SaveDecryptError(`不支持的存档容器版本 ${version}`);
  }
  const iv = blob.subarray(6, 6 + IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(6 + IV_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw new SaveDecryptError("存档解密失败（密钥错误或文件已篡改）");
  }
}

export function decryptSaveBlobBase64(b64: string): unknown {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    throw new SaveDecryptError("存档 base64 无效");
  }
  return decryptSaveBlob(buf);
}

export function encryptSaveDocumentBase64(doc: unknown): string {
  return encryptSaveDocument(doc).toString("base64");
}

/** Read repo-root version.json next to manager package. */
export function readGameVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/ → manager/ → repo root; src/ → manager/ → repo root
    const root = join(here, "..", "..");
    const raw = readFileSync(join(root, "version.json"), "utf8");
    const j = JSON.parse(raw) as { version?: string };
    return typeof j.version === "string" ? j.version : "unknown";
  } catch {
    return "unknown";
  }
}
