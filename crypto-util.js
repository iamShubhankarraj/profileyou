const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

// Get encryption key from environment (must be 32 bytes = 64 hex chars)
function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    // Auto-generate a key if not set (for development only)
    console.warn('[SECURITY] ENCRYPTION_KEY not set or too short. Using fallback key. Set a proper 64-char hex key in .env for production.');
    return crypto.createHash('sha256').update('profileyou-dev-fallback-key').digest();
  }
  // If it's a hex string, convert to buffer; otherwise hash it
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return Buffer.from(key, 'hex');
  }
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypt plaintext using AES-256-GCM
 * @param {string} plaintext - The text to encrypt
 * @returns {string} - Format: iv:authTag:ciphertext (all hex-encoded)
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an encrypted string back to plaintext
 * @param {string} encryptedString - Format: iv:authTag:ciphertext
 * @returns {string} - The decrypted plaintext
 */
function decrypt(encryptedString) {
  if (!encryptedString) return null;
  
  const key = getKey();
  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted string format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = parts[2];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

module.exports = { encrypt, decrypt };
