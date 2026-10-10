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
    const q = query.q?.trim();

    const where: Prisma.MatchedPostWhereInput = {
      userMonitor: {
        userId: user.id,
        ...(query.monitorId ? { id: query.monitorId } : {}),
        ...(query.sourceId ? { sourceId: query.sourceId } : {}),
        ...(query.sourceType ? { source: { type: query.sourceType } } : {}),
      },
      ...(query.from ? { createdAt: { gte: new Date(query.from) } } : {}),
      ...(q
        ? {
            OR: [
              { processedPost: { title: { contains: q, mode: 'insensitive' } } },
              { processedPost: { aiSummary: { contains: q, mode: 'insensitive' } } },
              { processedPost: { rawContent: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const total = await this.prisma.matchedPost.count({ where });
    const rows = await this.prisma.matchedPost.findMany({
      where,
      orderBy: {
        processedPost: { publishedAt: { sort: 'desc', nulls: 'last' } },
      },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        processedPost: true,
        userMonitor: { include: { source: true } },
      },
    });

    const nameByUrl = await this.resolveEntityNames(
      rows.map((row) => row.processedPost.url),
    );
    const favorited = await this.favorites.favoritedSet(
      user.id,
      rows.map((row) => row.processedPost.id),
    );

    return {
      aiEnabled: user.aiEnabled,
      items: rows.map((row) =>
        this.present(
          row,
          nameByUrl.get(entityUrlFromPost(row.processedPost.url) ?? '') ?? null,
          favorited.has(row.processedPost.id),
        ),
      ),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
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
