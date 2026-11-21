import { BadRequestException } from '@nestjs/common';

type RawCursor = Record<string, unknown>;

export type NewsCursor = {
  publishedAt: Date;
  createdAt: Date;
  id: string;
};

export type AlertCursor = {
  publishedAt: Date | null;
  id: string;
};

function invalidCursor(): never {
  throw new BadRequestException('Curseur invalide.');
}

function parseCursor(raw: string): RawCursor {
  try {
    const value = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      invalidCursor();
    }
    return value as RawCursor;
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    invalidCursor();
  }
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) invalidCursor();
  return value;
}

function parseDate(value: unknown): Date {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    invalidCursor();
  }
  return new Date(value);
}

export function encodeNewsCursor(cursor: NewsCursor): string {
  return Buffer.from(
    JSON.stringify({
      publishedAt: cursor.publishedAt.toISOString(),
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeNewsCursor(raw: string): NewsCursor {
  const value = parseCursor(raw);
  return {
    publishedAt: parseDate(value.publishedAt),
    createdAt: parseDate(value.createdAt),
    id: parseId(value.id),
  };
}

export function encodeAlertCursor(cursor: AlertCursor): string {
  return Buffer.from(
    JSON.stringify({
      publishedAt: cursor.publishedAt?.toISOString() ?? null,
      id: cursor.id,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeAlertCursor(raw: string): AlertCursor {
  const value = parseCursor(raw);
  if (value.publishedAt !== null && typeof value.publishedAt !== 'string') {
    invalidCursor();
  }
  return {
    publishedAt:
      value.publishedAt === null ? null : parseDate(value.publishedAt),
    id: parseId(value.id),
  };
}
