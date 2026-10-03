/** Internal messaging users have no mailbox and cannot authenticate by email. */
export function isMessagingEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@messaging.invalid");
}

/**
 * Self-service signup is permanently closed (CAAH-43). Any legacy
 * SIGNUPS_ENABLED value or stored `signupsEnabled` row is ignored; accounts
 * come only from operator provisioning.
 */
export function signupsOpen(_legacyValue?: string | boolean | null): false {
  return false;
}
