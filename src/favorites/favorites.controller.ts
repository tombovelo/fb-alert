import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { User } from '@prisma/client';
import { ApiKeyUser } from '../common/decorators/api-key-user.decorator';
import { FavoritesQueryDto } from './dto/favorites.query';
import { FavoritesService } from './favorites.service';

@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  list(@ApiKeyUser() user: User, @Query() query: FavoritesQueryDto) {
    return this.favorites.list(user, query);
  }

  @Post(':postId')
  toggle(
    @ApiKeyUser() user: User,
    @Param('postId', ParseUUIDPipe) postId: string,
  ) {
    return this.favorites.toggle(user, postId);
  }
}
