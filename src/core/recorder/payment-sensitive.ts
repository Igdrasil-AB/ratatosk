/**
 * Payment values are sensitive even when an API gives them an unexpected
 * field name. Keep the detector deliberately narrow: keys cover known payment
 * fields; value matching requires a valid PAN checksum or IBAN checksum.
 */
const PAYMENT_FIELD = /(?:^|_)(?:card(?:_?(?:number|pan|cvc|cvv|security_?code))?|cvv|cvc|iban|bic|swift|bank(?:_?(?:account|number|routing|code))?|routing(?:_?number)?|account_?number|sort_?code)(?:_|$)/i;
// Avoid treating UUIDs and other dashed identifiers as card numbers. We accept
// the common contiguous form and conventional 4-digit groups only; both still
// require Luhn validation below.
const CARD_CANDIDATE = /\b(?:\d{13,19}|\d{4}(?:[ -]\d{4}){3})\b/g;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/gi;

export function isPaymentSensitiveKey(key: string): boolean {
  return PAYMENT_FIELD.test(normalizeKey(key));
}

export function isPaymentSensitiveValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return hasValidPaymentCard(value) || hasValidIban(value);
}

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

function hasValidPaymentCard(value: string): boolean {
  for (const candidate of value.match(CARD_CANDIDATE) ?? []) {
    const digits = candidate.replace(/[^\d]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double && (value *= 2) > 9) value -= 9;
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasValidIban(value: string): boolean {
  for (const candidate of value.match(IBAN_CANDIDATE) ?? []) {
    const iban = candidate.replace(/[ -]/g, "").toUpperCase();
    if (iban.length < 15 || iban.length > 34 || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) continue;
    const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
    let remainder = 0;
    for (const character of rearranged) {
      const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
      for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
    }
    if (remainder === 1) return true;
  }
  return false;
}
