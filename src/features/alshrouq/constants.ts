/**
 * The delivery method this feature is about.
 *
 * `orders.delivery_type` stores the courier's name verbatim — "AlShrouq",
 * "Azman", "Branch Scooter", "Store Pickup" — and `DELIVERY_TYPES` in
 * `@/lib/branches` is the list agents pick from. This names the one entry the
 * dispatch card keys on, rather than repeating the string literal in a
 * comparison where a typo would silently hide the card on every order.
 */
export const ALSHROUQ = "AlShrouq";

/**
 * How long a delivery note may be.
 *
 * Not a new limit — it is the one `orders.notes` already carries
 * (`orderFormSchema`: `z.string().max(500)`) and the one the dispatch server
 * function already enforces on `details` (`z.string().max(500)`). Named here so
 * the box an agent types into cannot drift away from the two validators that
 * decide whether what they typed is savable.
 */
export const ALSHROUQ_NOTE_MAX = 500;
