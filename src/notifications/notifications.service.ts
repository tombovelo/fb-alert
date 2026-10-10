import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationChannel,
  NotificationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AlertPayload {
  userId: string;
  matchedPostId?: string;
  title: string;
  body: string;
  channels?: NotificationChannel[];
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sendAlert(payload: AlertPayload) {
    const channels = payload.channels ?? ['WEB', 'PUSH', 'EMAIL'];
    const records = await Promise.all(
      channels.map((channel) =>
        this.prisma.notification.create({
          data: {
            userId: payload.userId,
            matchedPostId: payload.matchedPostId,
            channel,
            status: NotificationStatus.PENDING,
            title: payload.title,
            body: payload.body,
          },
        }),
      ),
    );

    this.logger.log(
      `Alerte enregistrée pour ${payload.userId} (${channels.join(', ')})`,
    );
    return records;
  }

  async markSent(id: string) {
    return this.prisma.notification.update({
      where: { id },
      data: { status: NotificationStatus.SENT, sentAt: new Date() },
    });
  }

  async markFailed(id: string) {
    return this.prisma.notification.update({
      where: { id },
      data: { status: NotificationStatus.FAILED },
    });
  }
}
