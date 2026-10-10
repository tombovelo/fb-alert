import { Controller, Get, Query } from '@nestjs/common';
import { User } from '@prisma/client';
import { ApiKeyUser } from '../common/decorators/api-key-user.decorator';
import { PostsService } from './posts.service';
import { PostsQueryDto } from './dto/posts.query';

@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  list(@ApiKeyUser() user: User, @Query() query: PostsQueryDto) {
    return this.posts.list(user, query);
  }
}
