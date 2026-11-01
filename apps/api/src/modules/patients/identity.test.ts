import { describe, expect, it } from 'vitest';
import { FullName, firstName, maskPhone, normalizeName } from '@sc/contracts';
import { getExampleNumber } from 'libphonenumber-js';
import examples from 'libphonenumber-js/mobile/examples';
import { parsePhone, validatePatientIdentity } from './identity';

describe('patient identity rules (BR-030, BR-031, BR-037, FR-PAT-002)', () => {
  it('BR-030: trims and collapses whitespace; accepts any script; rejects digits, emoji and brackets', () => {
    expect(FullName.parse('  Somchai   Fictional  ')).toBe('Somchai Fictional');
    for (const ok of ['Anne-Marie O’Neil', 'สมชาย ใจดี', 'J. R. Fictional']) expect(FullName.safeParse(ok).success).toBe(true);
    for (const bad of ['A', 'Agent 007', 'Smile 😀', '<b>x</b>', ' ', 'x'.repeat(101)]) expect(FullName.safeParse(bad).success).toBe(false);
  });
  it('FR-PAT-002: matching key is case-, whitespace- and diacritic-insensitive', () => {
    expect(normalizeName('  ÉLODIE   Fictionné ')).toBe('elodie fictionne');
    expect(normalizeName('elodie fictionne')).toBe(normalizeName('Élodie  FICTIONNÉ'));
  });
  it('BR-031: parses with the clinic default region and stores E.164', () => {
    expect(parsePhone('081 234 5678', 'TH')).toBe('+66812345678');
    expect(parsePhone('+66 81 234 5678', 'GB')).toBe('+66812345678');
    // TC-VAL-002 (IR-38): the GB fixture is the library's example mobile, not the reserved drama range +44 7700 900xxx.
    const gb = getExampleNumber('GB', examples)!;
    expect(parsePhone(gb.formatInternational(), 'TH')).toBe(gb.number);
    expect(parsePhone('+44 7700 900123', 'GB')).toBeNull(); // reserved range stays invalid (BR-031 unchanged)
    expect(parsePhone('0812345678999', 'TH')).toBeNull();
    expect(parsePhone('12345', 'TH')).toBeNull();
  });
  it('BR-037: name and valid phone are both mandatory', () => {
    expect(validatePatientIdentity({ fullName: 'Fictional Patient', phone: '0812345678' }, 'TH')).toEqual({ fullName: 'Fictional Patient', nameNormalized: 'fictional patient', phoneE164: '+66812345678' });
    for (const input of [{ fullName: 'Fictional Patient' }, { phone: '0812345678' }, { fullName: 'Fictional Patient', phone: '' }, { fullName: 'X', phone: '0812345678' }]) {
      expect(() => validatePatientIdentity(input, 'TH')).toThrow();
    }
  });
  it('BR-033 / BR-034: public display helpers', () => {
    expect(maskPhone('+66812345678')).toBe('•••• ••• 5678');
    expect(firstName('Somchai Fictional')).toBe('Somchai');
  });
});
