/** Hash a PIN string using SHA-256 via the Web Crypto API */
export async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin + "rcloneflix-salt");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  const hash = await hashPin(pin);
  return hash === storedHash;
}

// In-memory session PIN cached after successful PIN entry
let activeSessionPin = "";

export function setSessionPin(pin: string): void {
  activeSessionPin = pin;
}

export function getSessionPin(): string {
  return activeSessionPin;
}

export function clearSessionPin(): void {
  activeSessionPin = "";
}

/** Standard public vault encryption key for universal on-chain AES-256-GCM protection */
export const PUBLIC_VAULT_KEY = "rcloneflix-public-vault-2026";
