-- CreateTable
CREATE TABLE "FeishuNotifyBuffer" (
    "projectId" TEXT NOT NULL,
    "pending" JSONB NOT NULL DEFAULT '[]',
    "firstAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "dayStamp" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeishuNotifyBuffer_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE INDEX "FeishuNotifyBuffer_dueAt_idx" ON "FeishuNotifyBuffer"("dueAt");

-- AddForeignKey
ALTER TABLE "FeishuNotifyBuffer" ADD CONSTRAINT "FeishuNotifyBuffer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
