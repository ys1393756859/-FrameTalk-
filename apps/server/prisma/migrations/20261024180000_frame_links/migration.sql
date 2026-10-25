-- CreateTable
CREATE TABLE "FrameLink" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "baseVersionId" TEXT NOT NULL,
    "baseFrame" INTEGER NOT NULL,
    "versionId" TEXT NOT NULL,
    "frame" INTEGER NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FrameLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FrameLink_assetId_idx" ON "FrameLink"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameLink_baseVersionId_baseFrame_versionId_frame_key" ON "FrameLink"("baseVersionId", "baseFrame", "versionId", "frame");

-- AddForeignKey
ALTER TABLE "FrameLink" ADD CONSTRAINT "FrameLink_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameLink" ADD CONSTRAINT "FrameLink_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "AssetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameLink" ADD CONSTRAINT "FrameLink_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "AssetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameLink" ADD CONSTRAINT "FrameLink_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
