import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushTokenDto } from './dto/user.dto';

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
}
