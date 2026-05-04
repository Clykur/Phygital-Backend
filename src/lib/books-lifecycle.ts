/** Loan length for checkouts (days). */
export const CHECKOUT_DUE_DAYS = 14;

export function checkoutDueAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + CHECKOUT_DUE_DAYS);
  return d;
}

/**
 * Past-due hub loans stay `checked_out`; UI can treat dueAt < now as overdue.
 * (Legacy `overdue` status was removed in favor of a single checked_out state.)
 */
export async function reconcileOverdueBooks(): Promise<void> {
  /* no-op: overdue is derived from dueAt */
}
