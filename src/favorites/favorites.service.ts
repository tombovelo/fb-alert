import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { entityUrlFromPost } from '../common/facebook-url';
import { PrismaService } from '../prisma/prisma.service';

type FavoritePost = Prisma.ProcessedPostGetPayload<{
  include: { source: true };
}>;

export type FavoritesPageQuery = {
  page?: number;
  limit?: number;
};

@Injectable()
export class FavoritesService {
  private readonly logger = new Logger(FavoritesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * PostIds favorisés parmi une liste (pour peupler `favorited` dans les
   * listes). Retourne un set vide si la table n'existe pas encore, pour ne
   * jamais casser l'affichage en attendant la création de la table.
   */
  async favoritedSet(userId: string, postIds: string[]): Promise<Set<string>> {
    if (postIds.length === 0) return new Set<string>();
    try {
      const rows = await this.prisma.favorite.findMany({
        where: { userId, postId: { in: postIds } },
        select: { postId: true },
      });
      return new Set(rows.map((row) => row.postId));
    } catch (err) {
      this.logger.warn(
        `Favoris indisponibles (table absente ?) : ${(err as Error).message.slice(0, 120)}`,
      );
      return new Set<string>();
    }
  }

  async toggle(user: User, postId: string) {
    const post = await this.prisma.processedPost.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Publication introuvable.');

    try {
      const existing = await this.prisma.favorite.findUnique({
        where: { userId_postId: { userId: user.id, postId } },
      });
      if (existing) {
        await this.prisma.favorite.delete({ where: { id: existing.id } });
        return { postId, favorited: false };
      }
      await this.prisma.favorite.create({ data: { userId: user.id, postId } });
      return { postId, favorited: true };
    } catch (err) {
      // Course : créé entre-temps → on le retire (l'action reste un toggle).
      if ((err as { code?: string }).code === 'P2002') {
        await this.prisma.favorite.deleteMany({ where: { userId: user.id, postId } });
        return { postId, favorited: false };
      }
      throw err;
    }
  }

  async list(user: User, query: FavoritesPageQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = { userId: user.id };

    const total = await this.prisma.favorite.count({ where });
    const rows = await this.prisma.favorite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { post: { include: { source: true } } },
    });

    const entityUrls = [
      ...new Set(
        rows
          .map((row) => entityUrlFromPost(row.post.url))
          .filter((url): url is string => Boolean(url)),
      ),
    ];
    const names =
      entityUrls.length > 0
        ? await this.prisma.facebookEntityName.findMany({
            where: { url: { in: entityUrls }, name: { not: '' } },
            select: { url: true, name: true },
          })
        : [];
    const nameByUrl = new Map(names.map((row) => [row.url, row.name]));

    return {
      items: rows.map((row) =>
        this.presentPost(
          row.post,
          nameByUrl.get(entityUrlFromPost(row.post.url) ?? '') ?? null,
        ),
      ),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  private presentPost(post: FavoritePost, sourceLabel: string | null) {
    return {
      id: post.id,
      title: post.title,
      imageUrl: post.imageUrl,
      url: post.url,
      author: post.author,
      publishedAt: post.publishedAt,
      createdAt: post.createdAt,
      extractedPrice: post.extractedPrice,
      aiSummary: post.aiSummary,
      rawContent: post.rawContent,
      sourceLabel,
      source: {
        id: post.source.id,
        type: post.source.type,
        url: post.source.url,
        name: post.source.name,
      },
      favorited: true,
    };
  }
}
