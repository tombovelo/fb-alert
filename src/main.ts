import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
    allowedHeaders: ['Content-Type', 'X-API-KEY', 'Authorization'],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  app.useStaticAssets(join(__dirname, '..', 'public'), { prefix: '/' });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API ready on http://localhost:${port}/api`);
  console.log(`Download page on http://localhost:${port}/`);
}

bootstrap();

