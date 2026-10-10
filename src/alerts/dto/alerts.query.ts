import { Type } from 'class-transformer';
import { SourceType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class AlertsQueryDto {
  @IsOptional()
  @IsUUID()
  monitorId?: string;

  @IsOptional()
  @IsUUID()
  sourceId?: string;

  /** Filtre par type de source (MARKETPLACE, FEED, PAGE, GROUP). */
  @IsOptional()
  @IsEnum(SourceType)
  sourceType?: SourceType;

  /** Recherche plein texte (titre, résumé IA, contenu). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
