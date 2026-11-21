import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { entityUrlFromPost } from '../common/facebook-url';
import { decodeNewsCursor, encodeNewsCursor } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { FavoritesService } from '../favorites/favorites.service';
import { PostsQueryDto } from './dto/posts.query';

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly favorites: FavoritesService,
  ) {}

  async list(user: User, query: PostsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeNewsCursor(query.cursor) : null;
    const q = query.q?.trim();

    // Surveillances en pause : date de mise en pause (« dernière modification »
    // du moniteur). C'est la coupure de News — voir AlertsService.list().
    const paused = await this.prisma.userMonitor.findMany({
      where: { userId: user.id, isActive: false },
      select: { sourceId: true, updatedAt: true },
    });

    const conditions: Prisma.ProcessedPostWhereInput[] = [
      {
        source: {
          // Les non-admin ne voient pas le Fil (FEED) dans News.
          ...(user.role === 'ADMIN'
            ? { type: { not: 'MARKETPLACE' } }
            : { type: { notIn: ['MARKETPLACE', 'FEED'] } }),
        },
      },
      // Visibilité : surveillance active → tous les posts du groupe ;
      // surveillance en pause → uniquement ceux reçus avant la mise en pause.
      {
        OR: [
          { source: { monitors: { some: { userId: user.id, isActive: true } } } },
          ...paused.map((monitor) => ({
            sourceId: monitor.sourceId,
            createdAt: { lte: monitor.updatedAt },
          })),
        ],
      },
      // Publications « complètes » : auteur, texte et date de publication présents.
      { author: { not: null } },
      { publishedAt: { not: null } },
      { rawContent: { not: '' } },
    ];

    if (q) {
      conditions.push({
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { rawContent: { contains: q, mode: 'insensitive' } },
          { aiSummary: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    if (query.from) {
      const since = new Date(query.from);
      conditions.push({
        OR: [{ publishedAt: { gte: since } }, { createdAt: { gte: since } }],
      });
    }

    if (cursor) {
      conditions.push({
        OR: [
          { publishedAt: { lt: cursor.publishedAt } },
          {
            publishedAt: cursor.publishedAt,
            createdAt: { lt: cursor.createdAt },
          },
          {
            publishedAt: cursor.publishedAt,
            createdAt: cursor.createdAt,
            id: { lt: cursor.id },
          },
        ],
      });
    }

    const where: Prisma.ProcessedPostWhereInput = { AND: conditions };

    const rows = await this.prisma.processedPost.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: cursor ? undefined : (page - 1) * limit,
      take: limit + 1,
      select: {
        id: true,
        title: true,
        imageUrl: true,
        url: true,
        author: true,
        publishedAt: true,
        createdAt: true,
        extractedPrice: true,
        aiSummary: true,
        rawContent: true,
        source: { select: { id: true, type: true, url: true, name: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last?.publishedAt
        ? encodeNewsCursor({
            publishedAt: last.publishedAt,
            createdAt: last.createdAt,
            id: last.id,
          })
        : null;

    // Nom réel du groupe/page propriétaire (cache des entités naviguées).
    const entityUrls = [
      ...new Set(
        items
          .map((item) => entityUrlFromPost(item.url))
          .filter((url): url is string => Boolean(url)),
      ),
    ];
    const entityNames =
      entityUrls.length > 0
        ? await this.prisma.facebookEntityName.findMany({
            where: { url: { in: entityUrls }, name: { not: '' } },
            select: { url: true, name: true },
          })
        : [];
    const nameByUrl = new Map(
      entityNames.map((entry) => [entry.url, entry.name]),
    );

    const favorited = await this.favorites.favoritedSet(
      user.id,
      items.map((item) => item.id),
    );

    return {
      items: items.map((item) => ({
        ...item,
        sourceLabel:
          nameByUrl.get(entityUrlFromPost(item.url) ?? '') ?? null,
        favorited: favorited.has(item.id),
      })),
      hasMore,
      nextCursor,
    };
  }
}
