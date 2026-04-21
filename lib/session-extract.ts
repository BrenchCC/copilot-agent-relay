/**
 * Extract a session-affinity key from the request body.
 *
 * Uses `metadata.user_id` as-is when present — requests from the same
 * client session carry the same value, and different sessions carry
 * different values, which is exactly what we need for sticky routing.
 */
export function extractSessionKey(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const meta = (body as { metadata?: unknown }).metadata;
  if (!meta || typeof meta !== "object") return null;
  const userId = (meta as { user_id?: unknown }).user_id;
  if (typeof userId === "string" && userId.length > 0) return userId;
  return null;
}
