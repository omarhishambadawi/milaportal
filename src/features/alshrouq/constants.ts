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
