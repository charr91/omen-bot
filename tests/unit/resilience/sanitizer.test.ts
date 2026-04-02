import { describe, expect, it } from 'vitest';
import { sanitizeForLogPayload } from '../../../src/resilience/sanitizer.js';

describe('sanitizeForLogPayload', () => {
  it('caps recursion depth for deeply nested objects', () => {
    const payload = {
      a: {
        b: {
          c: {
            d: {
              e: {
                f: {
                  g: 'too deep',
                },
              },
            },
          },
        },
      },
    };

    expect(sanitizeForLogPayload(payload)).toEqual({
      a: {
        b: {
          c: {
            d: {
              e: {
                f: '[max-depth]',
              },
            },
          },
        },
      },
    });
  });
});
