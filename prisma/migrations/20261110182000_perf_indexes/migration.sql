-- CreateIndex
CREATE INDEX "Favorite_userId_createdAt_idx" ON "Favorite"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Favorite_postId_idx" ON "Favorite"("postId");

-- CreateIndex
CREATE INDEX "MatchedPost_userMonitorId_createdAt_idx" ON "MatchedPost"("userMonitorId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_matchedPostId_idx" ON "Notification"("matchedPostId");

-- CreateIndex
CREATE INDEX "ProcessedPost_createdAt_idx" ON "ProcessedPost"("createdAt");

-- CreateIndex
CREATE INDEX "ProcessedPost_publishedAt_createdAt_idx" ON "ProcessedPost"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Source_status_idx" ON "Source"("status");
