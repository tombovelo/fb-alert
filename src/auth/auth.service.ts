import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (exists) throw new ConflictException('Cet email est déjà utilisé.');

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash: await bcrypt.hash(dto.password, 10),
        aiEnabled: false,
      },
    });

    return this.publicUser(user.id);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user) throw new UnauthorizedException('Identifiants invalides.');

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Identifiants invalides.');

    return this.publicUser(user.id);
  }

  async validateApiKey(apiKey: string) {
    const user = await this.prisma.user.findUnique({ where: { apiKey } });
    if (!user) throw new UnauthorizedException('Clé API invalide.');
    return user;
  }

  private async publicUser(id: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        email: true,
        apiKey: true,
        role: true,
        subscriptionStatus: true,
        pushToken: true,
        createdAt: true,
      },
    });
  }
}
