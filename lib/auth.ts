import { createHash, timingSafeEqual } from "node:crypto";

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

export function verifyBearer(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (!token) return false;

  const provided = sha256(token);
  const expected = sha256(secret);
  return timingSafeEqual(provided, expected);
}
