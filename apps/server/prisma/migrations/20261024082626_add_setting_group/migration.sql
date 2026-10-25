-- CreateTable
CREATE TABLE "SettingGroup" (
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettingGroup_pkey" PRIMARY KEY ("key")
);
