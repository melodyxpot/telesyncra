export function isAllowedUser(fromId: number | string | null | undefined, allowedUserId: string): boolean {
  if (fromId === undefined || fromId === null) return false;
  if (!/^[1-9]\d{0,19}$/.test(allowedUserId)) return false;
  const candidate = String(fromId).trim();
  if (!/^[1-9]\d{0,19}$/.test(candidate)) return false;
  return candidate === allowedUserId;
}
