import { authenticate } from "../shopify.server";
import { existsSync, unlinkSync } from "node:fs";
import { saveEvent, FAIL_FLAG } from "../webhook-log.server";

// POST /webhooks/catalog — products/create + products/delete (subscribed in shopify.app.toml).
// authenticate.webhook checks the X-Shopify-Hmac-Sha256 signature first: a fake request never gets past this line.
export const action = async ({ request }) => {
  const hook = await authenticate.webhook(request);
  const { topic, payload } = hook;

  const summary =
    topic === "PRODUCTS_CREATE" ? `Created "${payload.title}" (${payload.status})` :
    topic === "PRODUCTS_DELETE" ? `Deleted product ${payload.id}` :
    topic;
  const saved = await saveEvent(hook, summary);

  // Demo switch ("Fail the next delivery" on the Webhooks page): answer 500 once and watch Shopify
  // send the SAME event again (same eventId → deliveries 2, not a duplicate row).
  if (existsSync(FAIL_FLAG) && saved.deliveries === 1) {
    unlinkSync(FAIL_FLAG);
    return new Response("failing on purpose", { status: 500 });
  }

  // Answer fast (Shopify waits 5 seconds); do slow work in a queue, not here.
  return new Response();
};
