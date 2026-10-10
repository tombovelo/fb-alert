-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('PAGE', 'GROUP', 'MARKETPLACE');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('WEB', 'PUSH', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "pushToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,
    "name" TEXT,
    "checkIntervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "lastScrapedAt" TIMESTAMP(3),
    "status" "SourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMonitor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "keywords" TEXT[],
    "negativeKeywords" TEXT[],
    "minPrice" DOUBLE PRECISION,
    "maxPrice" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMonitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedPost" (
    "id" TEXT NOT NULL,
    "facebookPostId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "url" TEXT,
    "author" TEXT,
    "rawContent" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "extractedPrice" DOUBLE PRECISION,
    "aiSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchedPost" (
    "id" TEXT NOT NULL,
    "processedPostId" TEXT NOT NULL,
    "userMonitorId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchedPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchedPostId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_apiKey_key" ON "User"("apiKey");

-- CreateIndex
CREATE UNIQUE INDEX "Source_url_key" ON "Source"("url");

-- CreateIndex
CREATE INDEX "UserMonitor_userId_idx" ON "UserMonitor"("userId");

-- CreateIndex
CREATE INDEX "UserMonitor_sourceId_idx" ON "UserMonitor"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "UserMonitor_userId_sourceId_key" ON "UserMonitor"("userId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedPost_facebookPostId_key" ON "ProcessedPost"("facebookPostId");

-- CreateIndex
CREATE INDEX "ProcessedPost_sourceId_createdAt_idx" ON "ProcessedPost"("sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "MatchedPost_userMonitorId_idx" ON "MatchedPost"("userMonitorId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchedPost_processedPostId_userMonitorId_key" ON "MatchedPost"("processedPostId", "userMonitorId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserMonitor" ADD CONSTRAINT "UserMonitor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMonitor" ADD CONSTRAINT "UserMonitor_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessedPost" ADD CONSTRAINT "ProcessedPost_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchedPost" ADD CONSTRAINT "MatchedPost_processedPostId_fkey" FOREIGN KEY ("processedPostId") REFERENCES "ProcessedPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchedPost" ADD CONSTRAINT "MatchedPost_userMonitorId_fkey" FOREIGN KEY ("userMonitorId") REFERENCES "UserMonitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_matchedPostId_fkey" FOREIGN KEY ("matchedPostId") REFERENCES "MatchedPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
