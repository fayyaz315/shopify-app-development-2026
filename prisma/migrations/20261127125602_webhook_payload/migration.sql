/*
  Warnings:

  - Added the required column `payload` to the `WebhookEvent` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WebhookEvent" (
    "eventId" TEXT NOT NULL PRIMARY KEY,
    "webhookId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "triggeredAt" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveries" INTEGER NOT NULL DEFAULT 1
);
INSERT INTO "new_WebhookEvent" ("deliveries", "eventId", "receivedAt", "shop", "summary", "topic", "triggeredAt", "webhookId") SELECT "deliveries", "eventId", "receivedAt", "shop", "summary", "topic", "triggeredAt", "webhookId" FROM "WebhookEvent";
DROP TABLE "WebhookEvent";
ALTER TABLE "new_WebhookEvent" RENAME TO "WebhookEvent";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
