import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { detectPhone } from '../analyzer/ai.service';
import { entityUrlFromPost } from '../common/facebook-url';
import { decodeAlertCursor, encodeAlertCursor } from '../common/pagination';
import { FavoritesService } from '../favorites/favorites.service';
import { AlertsQueryDto } from './dto/alerts.query';

type AlertRow = {
  id: string;
  confidence: number | null;
  createdAt: Date;
  processedPost: {
    id: string;
    title: string | null;
    imageUrl: string | null;
    url: string | null;
    author: string | null;
    publishedAt: Date | null;
    aiSummary: string | null;
    extractedPrice: number | null;
    rawContent: string;
  };
  userMonitor: {
    id: string;
    keywords: string[];
    negativeKeywords: string[];
    minPrice: number | null;
    maxPrice: number | null;
    userId: string;
    source: { id: string; type: string; url: string; name: string | null };
  };
};

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly favorites: FavoritesService,
  ) {}

  async list(user: User, query: AlertsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeAlertCursor(query.cursor) : null;
    const q = query.q?.trim();

    // Surveillances en pause : date de mise en pause (coupure, comme News).
    const paused = await this.prisma.userMonitor.findMany({
      where: { userId: user.id, isActive: false },
      select: { id: true, updatedAt: true },
    });

    const search: Prisma.MatchedPostWhereInput | undefined = q
      ? {
          OR: [
            { processedPost: { title: { contains: q, mode: 'insensitive' } } },
            { processedPost: { aiSummary: { contains: q, mode: 'insensitive' } } },
            { processedPost: { rawContent: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : undefined;

    const conditions: Prisma.MatchedPostWhereInput[] = [
      {
        userMonitor: {
          userId: user.id,
          ...(query.monitorId ? { id: query.monitorId } : {}),
          ...(query.sourceId ? { sourceId: query.sourceId } : {}),
          ...(query.sourceType
            ? user.role === 'ADMIN' || query.sourceType !== 'FEED'
              ? { source: { type: query.sourceType } }
              : { source: { type: { not: 'FEED' } } }
            : // Filtre « Toutes » : les non-admin ne voient pas le Fil (FEED).
              user.role !== 'ADMIN'
              ? { source: { type: { not: 'FEED' } } }
              : {}),
        },
      },
      // Visibilité : même règle que News — surveillance active → tous les
      // posts ; surveillance en pause → uniquement ceux d'avant la mise en pause.
      {
        OR: [
          { userMonitor: { isActive: true } },
          ...paused.map((monitor) => ({
            userMonitorId: monitor.id,
            createdAt: { lte: monitor.updatedAt },
          })),
        ],
      },
      ...(query.from ? [{ createdAt: { gte: new Date(query.from) } }] : []),
      ...(search ? [search] : []),
    ];

    if (cursor) {
      conditions.push({
        OR: cursor.publishedAt
          ? [
              {
                processedPost: {
                  publishedAt: { lt: cursor.publishedAt },
                },
              },
              {
                processedPost: { publishedAt: cursor.publishedAt },
                id: { lt: cursor.id },
              },
              { processedPost: { publishedAt: null } },
            ]
          : [
              {
                processedPost: { publishedAt: null },
                id: { lt: cursor.id },
              },
            ],
      });
    }

    const where: Prisma.MatchedPostWhereInput = { AND: conditions };

    const rows = await this.prisma.matchedPost.findMany({
      where,
      orderBy: [
        {
          processedPost: { publishedAt: { sort: 'desc', nulls: 'last' } },
        },
        { id: 'desc' },
      ],
      skip: cursor ? undefined : (page - 1) * limit,
      take: limit + 1,
      include: {
        processedPost: true,
        userMonitor: { include: { source: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeAlertCursor({
            publishedAt: last.processedPost.publishedAt,
            id: last.id,
          })
        : null;

    const nameByUrl = await this.resolveEntityNames(
      items.map((row) => row.processedPost.url),
    );
    const favorited = await this.favorites.favoritedSet(
      user.id,
      items.map((row) => row.processedPost.id),
    );

    return {
      aiEnabled: user.aiEnabled,
      items: items.map((row) =>
        this.present(
          row,
          nameByUrl.get(entityUrlFromPost(row.processedPost.url) ?? '') ?? null,
          favorited.has(row.processedPost.id),
        ),
      ),
      hasMore,
      nextCursor,
    };
  }

  async detail(user: User, id: string) {
    const row = await this.prisma.matchedPost.findUnique({
      where: { id },
      include: {
        processedPost: true,
        userMonitor: { include: { source: true } },
      },
    });
    if (!row) throw new NotFoundException('Alerte introuvable.');
    if (row.userMonitor.userId !== user.id) {
      throw new ForbiddenException(
        "Cette alerte n'appartient pas à cet utilisateur.",
      );
    }
    const nameByUrl = await this.resolveEntityNames([row.processedPost.url]);
    const favorited = await this.favorites.favoritedSet(user.id, [row.processedPost.id]);
    return this.present(
      row,
      nameByUrl.get(entityUrlFromPost(row.processedPost.url) ?? '') ?? null,
      favorited.has(row.processedPost.id),
    );
  }

  /** Nom réel du groupe/page (cache des entités naviguées). */
  private async resolveEntityNames(urls: (string | null)[]) {
    const entityUrls = [...new Set(urls.map((url) => entityUrlFromPost(url)).filter((url): url is string => Boolean(url)))];
    if (entityUrls.length === 0) return new Map<string, string>();
    const rows = await this.prisma.facebookEntityName.findMany({
      where: { url: { in: entityUrls }, name: { not: '' } },
      select: { url: true, name: true },
    });
    return new Map(rows.map((row) => [row.url, row.name]));
  }

  private present(row: AlertRow, sourceLabel: string | null, favorited: boolean) {
    const post = row.processedPost;
    const monitor = row.userMonitor;
    return {
      id: row.id,
      detectedAt: row.createdAt,
      confidence: row.confidence,
      sourceLabel,
      favorited,
      post: {
        id: post.id,
        title: post.title,
        imageUrl: post.imageUrl,
        url: post.url,
        author: post.author,
        phone: detectPhone(post.rawContent),
        publishedAt: post.publishedAt,
        aiSummary: post.aiSummary,
        extractedPrice: post.extractedPrice,
        text: post.rawContent,
      },
      monitor: {
        id: monitor.id,
        keywords: monitor.keywords,
        negativeKeywords: monitor.negativeKeywords,
        minPrice: monitor.minPrice,
        maxPrice: monitor.maxPrice,
      },
      source: {
        id: monitor.source.id,
        type: monitor.source.type,
        url: monitor.source.url,
        name: monitor.source.name,
      },
    };
  }
}
