// Arch 14.1 / TC-VAL-003: strings are NFC-normalised and trimmed before validation.
// Password fields are NFC-normalised but never trimmed.
export function normalizeInput(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    const nfc = value.normalize('NFC');
    return /password/i.test(key) ? nfc : nfc.trim();
  }
  if (Array.isArray(value)) return value.map((v) => normalizeInput(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeInput(v, k)]));
  }
  return value;
}
