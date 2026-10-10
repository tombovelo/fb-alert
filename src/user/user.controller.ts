import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiKeyUser } from '../common/decorators/api-key-user.decorator';
import { User } from '@prisma/client';
import { UserService } from './user.service';
import { AiEnabledDto, PushTokenDto } from './dto/user.dto';

@Controller('user')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get()
  me(@ApiKeyUser() user: User) {
    return this.users.profile(user);
  }

  @Post('push-token')
  saveToken(@ApiKeyUser() user: User, @Body() dto: PushTokenDto) {
    return this.users.savePushToken(user, dto);
  }

  @Post('ai-enabled')
  setAiEnabled(@ApiKeyUser() user: User, @Body() dto: AiEnabledDto) {
    return this.users.setAiEnabled(user, dto.enabled);
  }
}
