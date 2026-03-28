import { describe, expect, it } from 'vitest';
import { parseApiCreds } from '../../../src/phase0/auth.js';

describe('phase0 auth helpers', () => {
  it('parses api credentials returned with apiKey naming', () => {
    expect(
      parseApiCreds({
        apiKey: 'api-key',
        secret: 'secret',
        passphrase: 'passphrase',
      }),
    ).toEqual({
      key: 'api-key',
      secret: 'secret',
      passphrase: 'passphrase',
    });
  });

  it('parses api credentials returned with key naming', () => {
    expect(
      parseApiCreds({
        key: 'api-key',
        secret: 'secret',
        passphrase: 'passphrase',
      }),
    ).toEqual({
      key: 'api-key',
      secret: 'secret',
      passphrase: 'passphrase',
    });
  });
});
