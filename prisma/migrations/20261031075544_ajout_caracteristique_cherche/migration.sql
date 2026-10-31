-- AlterTable
ALTER TABLE "UserMonitor" ADD COLUMN     "characteristics" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "locations" TEXT[] DEFAULT ARRAY[]::TEXT[];
