-- CreateTable
CREATE TABLE "FacebookEntityName" (
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacebookEntityName_pkey" PRIMARY KEY ("url")
);
