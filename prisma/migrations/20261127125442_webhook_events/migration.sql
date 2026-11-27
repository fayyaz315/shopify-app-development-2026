-- CreateTable
CREATE TABLE "WebhookEvent" (
    "eventId" TEXT NOT NULL PRIMARY KEY,
    "webhookId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "triggeredAt" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveries" INTEGER NOT NULL DEFAULT 1
);
