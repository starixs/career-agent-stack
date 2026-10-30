import { describe, expect, it } from 'vitest';

import { normalizeAuthCode } from '../server/career/mail/connectors';
import { authCodeProblem } from './mailAuthCode';

describe('mail auth code shape', () => {
  it('accepts 163-style codes that mix letters and digits', () => {
    expect(authCodeProblem('Ab3dEf7hIj9kLm1n')).toBeNull();
    expect(normalizeAuthCode('Ab3d Ef7h Ij9k Lm1n')).toBe('Ab3dEf7hIj9kLm1n');
  });

  it('says the length when the length is wrong, and the characters when the length is right', () => {
    expect(authCodeProblem('abcd')).toBe('授权码是 16 位，现在 4 位');
    expect(authCodeProblem('Ab3dEf7hIj9kLm1!')).toMatch(/只有字母和数字/);
    expect(normalizeAuthCode('Ab3dEf7hIj9kLm1!')).toBeNull();
  });
});
