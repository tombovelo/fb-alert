-- AlterTable
ALTER TABLE "ProcessedPost" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "lastScrapeDurationMs" INTEGER,
ADD COLUMN     "lastScrapeOrigin" TEXT;

-- CreateTable
CREATE TABLE "PostAnalysis" (
    "id" TEXT NOT NULL,
    "processedPostId" TEXT NOT NULL,
    "userMonitorId" TEXT NOT NULL,
    "isMatch" BOOLEAN NOT NULL,
    "extractedPrice" DOUBLE PRECISION,
    "summary" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostAnalysis_userMonitorId_idx" ON "PostAnalysis"("userMonitorId");

-- CreateIndex
CREATE UNIQUE INDEX "PostAnalysis_processedPostId_userMonitorId_key" ON "PostAnalysis"("processedPostId", "userMonitorId");

-- AddForeignKey
ALTER TABLE "PostAnalysis" ADD CONSTRAINT "PostAnalysis_processedPostId_fkey" FOREIGN KEY ("processedPostId") REFERENCES "ProcessedPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostAnalysis" ADD CONSTRAINT "PostAnalysis_userMonitorId_fkey" FOREIGN KEY ("userMonitorId") REFERENCES "UserMonitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
