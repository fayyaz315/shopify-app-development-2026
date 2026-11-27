import db from "./db.server";

// Demo only: when this file exists, /webhooks/catalog answers 500 to the next delivery.
export const FAIL_FLAG = "fail-next-webhook.flag";

// Episode 9: keep every webhook / event we receive. Shopify can deliver the same event more than once
// (retries), but eventId stays the same → upsert counts deliveries instead of saving a duplicate.
export async function saveEvent({ eventId, webhookId, shop, topic, triggeredAt, payload }, summary) {
  const id = eventId || webhookId;
  return db.webhookEvent.upsert({
    where: { eventId: id },
    create: {
      eventId: id, webhookId, shop, topic, summary,
      payload: JSON.stringify(payload).slice(0, 4000),
      triggeredAt: triggeredAt || null,
    },
    update: { deliveries: { increment: 1 } },
  });
}
