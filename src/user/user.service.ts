import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SubscriptionStatus, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminSubscriptionDto,
  PaymentPhoneDto,
  PushTokenDto,
  SubmitRequestDto,
} from './dto/user.dto';

/** Limite de surveillances (actives ou en pause) par statut d'abonnement. */
export const MONITOR_LIMITS: Record<SubscriptionStatus, number> = {
  TRIAL: 1,
  ACTIVE: 5,
  EXPIRED: 1,
  CANCELLED: 1,
};

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  profile(user: User) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        role: true,
        subscriptionStatus: true,
        subscriptionExpiresAt: true,
        pushToken: true,
        aiEnabled: true,
        createdAt: true,
        _count: { select: { monitors: true, notifications: true } },
      },
    });
  }

  setAiEnabled(user: User, enabled: boolean) {
    return this.prisma.user.update({
      where: { id: user.id },
      data: { aiEnabled: enabled },
      select: { id: true, aiEnabled: true },
    });
  }

  savePushToken(user: User, dto: PushTokenDto) {
    return this.prisma.user.update({
      where: { id: user.id },
      data: { pushToken: dto.token },
      select: { id: true, pushToken: true },
    });
  }

  /**
   * Liste des abonnements (utilisateurs non-admin) pour le menu admin.
   * Bascule automatiquement en EXPIRED un abonnement ACTIVE dont la date
   * de fin est passée.
   */
  async adminSubscriptions() {
    await this.expireLapsedSubscriptions();

    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        subscriptionStatus: true,
        subscriptionExpiresAt: true,
        subscriptionMonths: true,
        aiEnabled: true,
        createdAt: true,
        _count: { select: { monitors: true } },
        subscriptionRequest: {
          select: {
            id: true,
            months: true,
            paymentReference: true,
            senderPhone: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return users.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      subscriptionStatus: row.subscriptionStatus,
      subscriptionExpiresAt: row.subscriptionExpiresAt,
      subscriptionMonths: row.subscriptionMonths,
      aiEnabled: row.aiEnabled,
      monitorCount: row._count.monitors,
      createdAt: row.createdAt,
      pendingRequest: row.subscriptionRequest,
    }));
  }

  /**
   * Modifie l'abonnement d'un utilisateur.
   * - status ACTIVE + durationMonths (champ libre, en mois) → expiration =
   *   maintenant + N mois.
   * - status ACTIVE sans durée → sans expiration (illimité jusqu'à action).
   * - TRIAL / EXPIRED / CANCELLED → expiration vidée.
   */
  async adminUpdateSubscription(id: string, dto: AdminSubscriptionDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    const status = dto.subscriptionStatus as SubscriptionStatus;
    let expiresAt: Date | null = null;
    let months: number | null = null;
    if (status === 'ACTIVE' && dto.durationMonths != null) {
      if (dto.durationMonths < 1 || dto.durationMonths > 60) {
        throw new BadRequestException('La durée doit être entre 1 et 60 mois.');
      }
      months = dto.durationMonths;
      expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + dto.durationMonths);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        subscriptionStatus: status,
        subscriptionExpiresAt: expiresAt,
        subscriptionMonths: months,
      },
      select: {
        id: true,
        email: true,
        subscriptionStatus: true,
        subscriptionExpiresAt: true,
        subscriptionMonths: true,
      },
    });

    // Moniteurs : résiliation/expiration → ne garde qu'une surveillance
    // active ; réabonnement → réactive tout. L'admin est exempté.
    if (user.role !== 'ADMIN') {
      if (status === 'EXPIRED' || status === 'CANCELLED') {
        await this.keepOneActiveMonitor(id);
      } else if (status === 'ACTIVE') {
        await this.prisma.userMonitor.updateMany({
          where: { userId: id },
          data: { isActive: true },
        });
      }
    }

    // Acceptation : la demande en attente est consommée.
    if (status === 'ACTIVE') {
      await this.prisma.subscriptionRequest.deleteMany({ where: { userId: id } });
    }
    return updated;
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

  /** Numéro de téléphone de paiement (paramètre global). */
  async getPaymentPhone() {
    const row = await this.prisma.appSetting.findUnique({
      where: { key: 'paymentPhone' },
    });
    return { phone: row?.value ?? null };
  }

  async setPaymentPhone(dto: PaymentPhoneDto) {
    const phone = dto.phone.trim();
    await this.prisma.appSetting.upsert({
      where: { key: 'paymentPhone' },
      create: { key: 'paymentPhone', value: phone },
      update: { value: phone },
    });
    return { phone };
  }

  /** Envoi de la demande d'abonnement (une seule à la fois). */
  async submitSubscriptionRequest(user: User, dto: SubmitRequestDto) {
    const existing = await this.prisma.subscriptionRequest.findUnique({
      where: { userId: user.id },
    });
    if (existing) {
      throw new ConflictException(
        'Une demande est déjà en attente. Veuillez attendre sa validation.',
      );
    }
    // Abonnement actif non expiré : pas de nouvelle demande possible.
    if (
      user.subscriptionStatus === 'ACTIVE' &&
      (!user.subscriptionExpiresAt || user.subscriptionExpiresAt > new Date())
    ) {
      throw new ConflictException(
        'Vous avez déjà un abonnement actif. Veuillez attendre sa fin.',
      );
    }
    const request = await this.prisma.subscriptionRequest.create({
      data: {
        months: dto.months,
        paymentReference: dto.paymentReference.trim(),
        senderPhone: dto.senderPhone.trim(),
        userId: user.id,
      },
    });
    return {
      id: request.id,
      months: request.months,
      paymentReference: request.paymentReference,
      senderPhone: request.senderPhone,
      createdAt: request.createdAt,
    };
  }

  /** Demande en attente de l'utilisateur connecté (ou null). */
  async mySubscriptionRequest(user: User) {
    const request = await this.prisma.subscriptionRequest.findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        months: true,
        paymentReference: true,
        senderPhone: true,
        createdAt: true,
      },
    });
    return { request };
  }

  /** Rejet (suppression) d'une demande en attente. */
  async rejectSubscriptionRequest(id: string) {
    const request = await this.prisma.subscriptionRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException('Demande introuvable.');
    await this.prisma.subscriptionRequest.delete({ where: { id } });
    return { rejected: true, id };
  }

  /** Bascule un utilisateur en ADMIN ou USER. */
  async adminUpdateRole(id: string, role: 'ADMIN' | 'USER') {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }
    return this.prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, email: true, role: true },
    });
  }

  /** Bascule en EXPIRED tous les abonnements ACTIVE arrivés à échéance. */
  async expireLapsedSubscriptions() {
    const lapsed = await this.prisma.user.findMany({
      where: {
        subscriptionStatus: 'ACTIVE',
        subscriptionExpiresAt: { not: null, lt: new Date() },
      },
      select: { id: true, role: true },
    });
    if (lapsed.length === 0) return;

    await this.prisma.user.updateMany({
      where: { id: { in: lapsed.map((u) => u.id) } },
      data: { subscriptionStatus: 'EXPIRED' },
    });

    // Un seul moniteur actif conserve (sauf admin).
    for (const user of lapsed) {
      if (user.role === 'ADMIN') continue;
      await this.keepOneActiveMonitor(user.id);
    }
  }
}
