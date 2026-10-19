export type GtinCheck = { ok: true; value: string } | { ok: false; reason: 'length' | 'digits' | 'check_digit' };

const LENGTHS = [8, 12, 13, 14];

/** GS1 mod-10: from the right, the digit before the check digit weighs 3, then 1, 3, ... */
function checkDigitOk(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(digits[i]) * weight;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

export function validateGtin(raw: string): GtinCheck {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return { ok: false, reason: 'digits' };
  if (!LENGTHS.includes(value.length)) return { ok: false, reason: 'length' };
  return checkDigitOk(value) ? { ok: true, value } : { ok: false, reason: 'check_digit' };
}
