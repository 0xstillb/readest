export type GrimmLinkRequestErrorKind =
  | 'authentication'
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'rate-limit'
  | 'server'
  | 'transport'
  | 'response';

export class GrimmLinkRequestError extends Error {
  constructor(
    public readonly kind: GrimmLinkRequestErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GrimmLinkRequestError';
  }
}
