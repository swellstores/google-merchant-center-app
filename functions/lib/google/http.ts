export type GoogleErrorKind = 'auth' | 'rate' | 'daily_quota' | 'server' | 'not_found' | 'conflict' | 'data';

export class GoogleApiError extends Error {
  constructor(
    public readonly kind: GoogleErrorKind,
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}
