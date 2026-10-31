import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SourceType, User } from '@prisma/client';
import { guessSourceType } from '../common/facebook-url';
import { PrismaService } from '../prisma/prisma.service';
import { ScrapeQueueService } from '../queue/scraping-queue.service';
import { CreateMonitorDto, UpdateMonitorDto } from './dto/monitors.dto';
import { MONITOR_LIMITS } from '../user/user.service';

const LIMIT_MESSAGES: Record<string, string> = {
  TRIAL: 'Plan d’essai : vous pouvez suivre 1 source maximum, abonnez-vous.',
  ACTIVE: 'Plan actif : vous pouvez suivre 5 sources maximum.',
  EXPIRED: 'Abonnement expiré : vous pouvez suivre 1 source maximum, renouvelez votre abonnement.',
  CANCELLED: 'Abonnement résilié : vous pouvez suivre 1 source maximum.',
};

@Injectable()
export class MonitorsService {
  private readonly logger = new Logger(MonitorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ScrapeQueueService,
  ) { }

  async list(user: User) {
    const rows = await this.prisma.userMonitor.findMany({
      where: { userId: user.id },
      include: {
        source: {
          select: {
            id: true,
            url: true,
            type: true,
            name: true,
            status: true,
            checkIntervalMinutes: true,
            lastScrapedAt: true,
          },
        },
        _count: { select: { matchedPosts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(({ _count, ...monitor }) => ({
      ...monitor,
      matchedCount: _count.matchedPosts,
    }));
  }

  /**
   * Suggestions pour le champ URL de « Nouvelle surveillance » : pages et
   * groupes déjà connus, filtrés sur le nom et l'URL, en excluant les sources
   * que l'utilisateur surveille déjà. 5 résultats maximum.
   */
  async suggestSources(user: User, rawQuery?: string) {
    const q = (rawQuery ?? '').trim();
    if (q.length === 0) return [];

    const rows = await this.prisma.source.findMany({
      where: {
        type: { in: ['PAGE', 'GROUP'] },
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { url: { contains: q, mode: 'insensitive' } },
        ],
        monitors: { none: { userId: user.id } },
      },
      select: {
        id: true,
        url: true,
        type: true,
        name: true,
        _count: { select: { monitors: true } },
      },
      orderBy: { monitors: { _count: 'desc' } },
      take: 20,
    });

    const needle = q.toLowerCase();
    const rank = (name: string | null) => {
      const value = (name ?? '').toLowerCase();
      if (value === needle) return 0;
      if (value.startsWith(needle)) return 1;
      if (value.includes(needle)) return 2;
      return 3;
    };

    return rows
      .slice()
      .sort((a, b) => rank(a.name) - rank(b.name))
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        url: row.url,
        type: row.type,
        name: row.name ?? row.url,
      }));
  }

  async create(user: User, dto: CreateMonitorDto) {
    // L'admin n'est soumis à aucune limite d'abonnement.
    if (user.role !== 'ADMIN') {
      // Abonnement expiré à la volée : un ACTIVE dont la date de fin est
      // passée bascule en EXPIRED avant de vérifier la limite.
      if (
        user.subscriptionStatus === 'ACTIVE' &&
        user.subscriptionExpiresAt &&
        user.subscriptionExpiresAt < new Date()
      ) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { subscriptionStatus: 'EXPIRED' },
        });
        user.subscriptionStatus = 'EXPIRED';
        await this.keepOneActiveMonitor(user.id);
      }

      const limit = MONITOR_LIMITS[user.subscriptionStatus] ?? 1;
      const count = await this.prisma.userMonitor.count({
        where: { userId: user.id },
      });
      if (count >= limit) {
        throw new ConflictException(
          LIMIT_MESSAGES[user.subscriptionStatus] ??
          'Limite de sources atteinte, abonnez-vous.',
        );
      }
    }

    const url = this.normalizeUrl(dto.url);
    const type = dto.type ?? guessSourceType(url);
    if (type === 'FEED' && user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Seul un administrateur peut surveiller le Fil.',
      );
    }

    let source = await this.prisma.source.findUnique({ where: { url } });
    if (!source) {
      try {
        source = await this.prisma.source.create({
          data: {
            url,
            type,
            name: dto.url,
            checkIntervalMinutes: dto.checkIntervalMinutes ?? 5,
          },
        });
      } catch (err) {
        // Course : une requête simultanée a créé la même source entre-temps
        // (contrainte unique P2002) → on réutilise celle-ci.
        if ((err as { code?: string }).code !== 'P2002') throw err;
        source = await this.prisma.source.findUnique({ where: { url } });
        if (!source) throw new ConflictException('Cette source existe déjà.');
      }
      // Workflow A : une source neuve déclenche un scraping immédiat.
      await this.queue.addScrapeJob(source.id).catch((err: Error) => {
        this.logger.warn(`Job immédiat non enfilé pour ${url}: ${err.message}`);
      });
    }

    const existing = await this.prisma.userMonitor.findUnique({
      where: { userId_sourceId: { userId: user.id, sourceId: source.id } },
    });
    if (existing) {
      throw new ConflictException('Cette source est déjà surveillée.');
    }

    try {
      return await this.prisma.userMonitor.create({
        data: {
          userId: user.id,
          sourceId: source.id,
          keywords: dto.keywords ?? [],
          characteristics: dto.characteristics ?? [],
          locations: dto.locations ?? [],
          negativeKeywords: dto.negativeKeywords ?? [],
          minPrice: dto.minPrice,
          maxPrice: dto.maxPrice,
        },
        include: { source: true },
      });
    } catch (err) {
      // Course : ce même moniteur a été créé entre-temps →409 propre.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('Cette source est déjà surveillée.');
      }
      throw err;
    }
  }

  /**
   * Ne garde qu'un seul moniteur actif pour l'utilisateur (le plus ancien) ;
   * les autres sont mis en pause (isActive: false), jamais supprimés.
   */
  private async keepOneActiveMonitor(userId: string) {
    const monitors = await this.prisma.userMonitor.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, isActive: true },
    });
    const active = monitors.filter((m) => m.isActive);
    if (active.length <= 1) return;
    const keepId = active[0].id;
    await this.prisma.userMonitor.updateMany({
      where: { userId, isActive: true, id: { not: keepId } },
      data: { isActive: false },
    });
  }

  /**
   * Un utilisateur non-admin dont l'abonnement est expiré ou résilié ne peut
   * pas (ré)activer ses surveillances en pause — sauf la surveillance
   * conservée (la plus ancienne), qui reste gérable sans réabonnement.
   */
  private guardReactivation(
    user: User,
    monitor: { isActive: boolean },
    requested?: boolean,
    isKept = false,
  ) {
    if (user.role === 'ADMIN' || requested !== true) return;
    if (
      user.subscriptionStatus !== 'EXPIRED' &&
      user.subscriptionStatus !== 'CANCELLED'
    ) {
      return;
    }
    if (isKept) return;
    // Seule la désactivation (pause) est autorisée ; la réactivation est refusée.
    if (monitor.isActive === false) {
      throw new ForbiddenException(
        'Abonnement expiré ou résilié : réabonnez-vous pour réactiver vos surveillances.',
      );
    }
  }

  /**
   * Surveillance la plus ancienne de l'utilisateur : c'est celle que la règle
   * d'expiration/résiliation garde active. Un abonnement expiré ou résilié
   * peut entièrement la gérer (modifier, mettre en pause, rallumer) ; toutes
   * les autres surveillances restent en lecture seule — leur date de coupure
   * News/Alertes ne bouge donc jamais.
   */
  private async keptMonitorId(userId: string): Promise<string | null> {
    const oldest = await this.prisma.userMonitor.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return oldest?.id ?? null;
  }

  private guardEditIfLapsed(user: User, isKept: boolean) {
    if (user.role === 'ADMIN') return;
    if (
      user.subscriptionStatus !== 'EXPIRED' &&
      user.subscriptionStatus !== 'CANCELLED'
    ) {
      return;
    }
    if (isKept) return;
    throw new ForbiddenException(
      'Abonnement expiré ou résilié : cette surveillance est en lecture seule. Réabonnez-vous pour la modifier.',
    );
  }

  async update(user: User, id: string, dto: UpdateMonitorDto) {
    const owned = await this.owned(user, id);
    const isKept = (await this.keptMonitorId(user.id)) === id;
    this.guardReactivation(user, owned, dto.isActive, isKept);
    this.guardEditIfLapsed(user, isKept);
    const { sourceId, retiredSourceId } = await this.retargetSource(
      user,
      owned.sourceId,
      dto,
    );

    const monitor = await this.prisma.userMonitor.update({
      where: { id },
      data: {
        keywords: dto.keywords,
        characteristics: dto.characteristics,
        locations: dto.locations,
        negativeKeywords: dto.negativeKeywords,
        minPrice: dto.minPrice,
        maxPrice: dto.maxPrice,
        isActive: dto.isActive,
        sourceId,
      },
      include: { source: true },
    });

    if (dto.checkIntervalMinutes !== undefined) {
      await this.prisma.source.update({
        where: { id: sourceId },
        data: { checkIntervalMinutes: dto.checkIntervalMinutes },
      });
    }

    if (retiredSourceId) {
      const remaining = await this.prisma.userMonitor.count({
        where: { sourceId: retiredSourceId },
      });
      if (remaining === 0) {
        await this.prisma.source
          .delete({ where: { id: retiredSourceId } })
          .catch(() => undefined);
      }
      await this.queue.addScrapeJob(sourceId).catch((err: Error) => {
        this.logger.warn(`Job immédiat non enfilé après changement d'URL : ${err.message}`);
      });
    }

    return monitor;
  }

  /**
   * Changement d'URL et/ou de type : la surveillance est rattachée à la
   * (nouvelle) source, créée au besoin. L'ancienne source n'est supprimée
   * qu'après le ré-rattachement (contrainte de clé étrangère).
   */
  private async retargetSource(
    user: User,
    currentSourceId: string,
    dto: UpdateMonitorDto,
  ): Promise<{ sourceId: string; retiredSourceId?: string }> {
    const current = await this.prisma.source.findUnique({
      where: { id: currentSourceId },
    });
    if (!current) throw new NotFoundException('Source introuvable.');

    if (dto.url === undefined && dto.type === undefined) {
      return { sourceId: currentSourceId };
    }

    const targetUrl =
      dto.url !== undefined ? this.normalizeUrl(dto.url) : current.url;

    // URL identique : éventuellement un simple changement de type.
    if (targetUrl === current.url) {
      if (dto.type !== undefined && dto.type !== current.type) {
        await this.prisma.source.update({
          where: { id: current.id },
          data: { type: dto.type },
        });
      }
      return { sourceId: currentSourceId };
    }

    const type = dto.type ?? guessSourceType(targetUrl);
    let target = await this.prisma.source.findUnique({
      where: { url: targetUrl },
    });

    if (!target) {
      try {
        target = await this.prisma.source.create({
          data: {
            url: targetUrl,
            type,
            name: targetUrl,
            checkIntervalMinutes: current.checkIntervalMinutes,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
        target = await this.prisma.source.findUnique({ where: { url: targetUrl } });
        if (!target) throw new ConflictException('Cette source existe déjà.');
      }
    } else if (dto.type !== undefined && dto.type !== target.type) {
      await this.prisma.source.update({
        where: { id: target.id },
        data: { type: dto.type },
      });
    }

    const conflict = await this.prisma.userMonitor.findUnique({
      where: { userId_sourceId: { userId: user.id, sourceId: target.id } },
    });
    if (conflict) {
      throw new ConflictException('Cette source est déjà surveillée.');
    }

    return { sourceId: target.id, retiredSourceId: current.id };
  }

  /**
   * Réactivation immédiate d'une source en erreur : statut ACTIVE, compteur
   * d'erreurs à zéro, surveillance réactivée et scraping lancé tout de suite.
   */
  async reactivate(user: User, id: string) {
    const monitor = await this.owned(user, id);
    const isKept = (await this.keptMonitorId(user.id)) === id;
    this.guardReactivation(user, monitor, true, isKept);
    const source = await this.prisma.source.findUnique({
      where: { id: monitor.sourceId },
    });
    if (!source) throw new NotFoundException('Source introuvable.');

    await this.prisma.source.update({
      where: { id: source.id },
      data: { status: 'ACTIVE', consecutiveErrors: 0 },
    });
    await this.prisma.userMonitor.update({
      where: { id },
      data: { isActive: true },
    });

    await this.queue.addScrapeJob(source.id).catch((err: Error) => {
      this.logger.warn(`Réactivation : job non enfilé pour ${source.url}: ${err.message}`);
    });

    const updated = await this.prisma.userMonitor.findUnique({
      where: { id },
      include: { source: true, _count: { select: { matchedPosts: true } } },
    });
    if (!updated) throw new NotFoundException('Surveillance introuvable.');
    const { _count, ...rest } = updated;
    return { ...rest, matchedCount: _count.matchedPosts };
  }

  async remove(user: User, id: string) {
    const monitor = await this.owned(user, id);
    await this.prisma.userMonitor.delete({ where: { id } });

    const remaining = await this.prisma.userMonitor.count({
      where: { sourceId: monitor.sourceId },
    });
    if (remaining === 0) {
      await this.prisma.source.delete({
        where: { id: monitor.sourceId },
      }).catch(() => undefined);
    }

    return { deleted: true, id };
  }

  /** Vue admin : chaque source avec le nombre d'utilisateurs et toutes les
   *  surveillances (tous utilisateurs confondus). */
  async adminOverview() {
    const sources = await this.prisma.source.findMany({
      include: {
        monitors: {
          include: { user: { select: { id: true, email: true, role: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return sources.map(({ monitors, ...source }) => ({
      ...source,
      userCount: monitors.length,
      monitors: monitors.map(({ user, ...monitor }) => ({
        ...monitor,
        user,
      })),
    }));
  }

  /** Suppression totale d'une source (admin) : la Source, ses monitors,
   *  ses posts traités et leurs analyses/matches partent en cascade. */
  async adminDeleteSource(id: string) {
    const source = await this.prisma.source.findUnique({
      where: { id },
      include: { _count: { select: { monitors: true } } },
    });
    if (!source) throw new NotFoundException('Source introuvable.');

    await this.prisma.source.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Source impossible à supprimer.');
    });

    return { deleted: true, id, monitorsRemoved: source._count.monitors };
  }

  private normalizeUrl(raw: string) {
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw new BadRequestException('URL invalide.');
    }
    if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) {
      throw new BadRequestException(
        'Seules les URL Facebook sont acceptées.',
      );
    }
    parsed.hash = '';
    // Page à identifiant numérique : le paramètre id fait partie de l'adresse
    // (facebook.com/profile.php?id=61573939206035) — on le conserve.
    const profileId =
      parsed.pathname.replace(/\/+$/, '') === '/profile.php'
        ? parsed.searchParams.get('id')
        : null;
    parsed.search = '';
    if (profileId) parsed.searchParams.set('id', profileId);
    ['www.', 'm.', 'web.'].forEach((prefix) => {
      if (parsed.hostname.startsWith(prefix)) {
        parsed.hostname = parsed.hostname.slice(prefix.length);
      }
    });
    let path = parsed.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${parsed.origin}${path}${parsed.search}`;
  }

  private guessType(url: string): SourceType {
    return guessSourceType(url);
  }

  private async owned(user: User, id: string) {
    const monitor = await this.prisma.userMonitor.findUnique({ where: { id } });
    if (!monitor || monitor.userId !== user.id) {
      throw new NotFoundException('Surveillance introuvable.');
    }
    return monitor;
  }
}
