/**
 * The protected owner accounts. OWNER_EMAIL lists them, separated by commas or semicolons
 * (`a@swishhh.net,b@swishhh.net`); OWNER_NAME gives their names in the same order.
 */
export function ownerEmails(): string[] {
  const list = (process.env.OWNER_EMAIL ?? '')
    .split(/[,;]/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(list)];
}

export function isOwnerEmail(email: string): boolean {
  return ownerEmails().includes(email.trim().toLowerCase());
}

/** The name given for the owner at this position in OWNER_NAME, else the start of their address ("fawzan" -> "Fawzan"). */
export function ownerName(email: string): string {
  const names = (process.env.OWNER_NAME ?? '').split(/[,;]/).map((n) => n.trim());
  const given = names[ownerEmails().indexOf(email.trim().toLowerCase())];
  if (given) return given;
  const local = email.split('@')[0] ?? '';
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'Owner';
}
