import { authenticate } from "../shopify.server";
import { saveEvent } from "../webhook-log.server";

// POST /webhooks/products/update — the [events] subscription "product-price-change" in shopify.app.toml:
// Shopify only calls this when a variant's price or compare-at price changes on an ACTIVE product,
// and sends the result of OUR query (product + variant) instead of the full product.
export const action = async ({ request }) => {
  const hook = await authenticate.webhook(request);
  const data = hook.payload?.data ?? hook.payload ?? {};
  const v = data.productVariant;
  const summary = v
    ? `${data.product?.title ?? "Product"} · ${v.title}: price ${v.price}${v.compareAtPrice ? ` (was ${v.compareAtPrice})` : ""}`
    : `Price changed (${hook.topic})`;
  await saveEvent(hook, summary);
  return new Response();
};
