const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_CHARACTER_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const DEFAULT_MAX_TEXT_LENGTH = 1024;
const DEFAULT_MAX_DEPTH = 6;

interface SanitizeTextOptions {
  maxLength?: number;
  preserveNewlines?: boolean;
}

export function sanitizeForTerminal(value: string): string {
  return sanitizeText(value, {
    preserveNewlines: false,
  });
}

export function sanitizeForLogPayload<T>(value: T): T {
  return sanitizeUnknown(value, 0) as T;
}

export function sanitizeText(value: string, options: SanitizeTextOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const strippedAnsi = value.replace(ANSI_ESCAPE_PATTERN, '');
  const strippedControlCharacters = strippedAnsi.replace(CONTROL_CHARACTER_PATTERN, '');
  const normalizedWhitespace = options.preserveNewlines
    ? strippedControlCharacters.replaceAll('\r', '')
    : strippedControlCharacters.replaceAll(/\s+/g, ' ').trim();

  if (normalizedWhitespace.length <= maxLength) {
    return normalizedWhitespace;
  }

  return `${normalizedWhitespace.slice(0, Math.max(maxLength - 3, 1))}...`;
}

function sanitizeUnknown(value: unknown, depth: number): unknown {
  if (depth >= DEFAULT_MAX_DEPTH) {
    return '[max-depth]';
  }

  if (typeof value === 'string') {
    return sanitizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknown(entry, depth + 1));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeUnknown(entry, depth + 1)]),
    );
  }

  return value;
}
