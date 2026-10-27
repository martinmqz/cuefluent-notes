/** Stable failures for callers; messages must never include conversation content. */
export class CuefluentError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'CuefluentError';
    this.code = code;
  }
}

export function fail(code, message, cause) {
  throw new CuefluentError(code, message, cause ? { cause } : undefined);
}
