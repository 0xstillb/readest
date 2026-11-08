/** Stable buckets used by the UI/outbox to decide whether a sync is safe to retry. */
export type GrimmLinkErrorCategory = 'auth' | 'network' | 'server' | 'conflict' | 'invalid-data';

/**
 * Keep the detailed kinds for callers that need to distinguish a 404 or 429,
 * while exposing the production-facing category above.
 */
export type GrimmLinkRequestErrorKind =
  | 'authentication'
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'rate-limit'
  | 'server'
  | 'transport'
  | 'response';

const categoryForKind = (kind: GrimmLinkRequestErrorKind): GrimmLinkErrorCategory => {
  if (kind === 'authentication') return 'auth';
  if (kind === 'transport') return 'network';
  if (kind === 'validation' || kind === 'response') return 'invalid-data';
  if (kind === 'conflict') return 'conflict';
  return 'server';
};

export class GrimmLinkRequestError extends Error {
  constructor(
    public readonly kind: GrimmLinkRequestErrorKind,
    message: string,
    public readonly status?: number,
    public readonly category: GrimmLinkErrorCategory = categoryForKind(kind),
  ) {
    super(message);
    this.name = 'GrimmLinkRequestError';
  }
}
