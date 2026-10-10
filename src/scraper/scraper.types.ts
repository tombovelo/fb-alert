import { SourceType } from '@prisma/client';

export type PostOrigin = 'graphql' | 'dom';

export type ScrapeErrorKind =
  | 'not_found'
  | 'login_required'
  | 'blocked'
  | 'timeout'
  | 'network'
  | 'unknown';

export class ScrapeError extends Error {
  constructor(
    readonly kind: ScrapeErrorKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ScrapeError';
  }
}

export interface ScrapedCandidate {
  facebookPostId?: string;
  url?: string;
  author?: string;
  text: string;
  title?: string;
  price?: number;
  imageUrl?: string;
  publishedAt?: Date;
  origin: PostOrigin;
}

export interface ScrapedPost extends Required<
  Pick<ScrapedCandidate, 'facebookPostId' | 'text' | 'origin'>
> {
  url?: string;
  author?: string;
  title?: string;
  price?: number;
  imageUrl?: string;
  publishedAt?: Date;
}

export interface ScrapeResult {
  sourceUrl: string;
  type: SourceType;
  posts: ScrapedPost[];
  origin: PostOrigin | 'none';
  durationMs: number;
  /** Nom réel de la page/groupe (title/og:title) si disponible. */
  pageName?: string | null;
}
