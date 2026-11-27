import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { writeFileSync } from "node:fs";
import db from "../db.server";
import { FAIL_FLAG } from "../webhook-log.server";

const TEST_TITLE = "Webhook test tee";

// ─── READ ────────────────────────────────────────────────────────────────────
// The events come from OUR database: the webhook routes save them, this page only reads them.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const events = await db.webhookEvent.findMany({
    where: { shop: session.shop }, orderBy: { receivedAt: "desc" }, take: 20,
  });
  return {
    events: events.map((e) => ({ ...e, receivedAt: e.receivedAt.toISOString() })),
  };
};

// ─── WRITE: real store changes, so Shopify sends real webhooks ───────────────
// By ID, not by search: product search lags a few seconds behind a brand-new product.
const FIND = `#graphql
  query FindTest($id: ID!) {
    product(id: $id) { id title variants(first: 1) { nodes { id price } } }
  }`;
const CREATE = `#graphql
  mutation CreateTest($product: ProductCreateInput!) {
    productCreate(product: $product) { product { id } userErrors { field message } }
  }`;
const RENAME = `#graphql
  mutation Rename($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { title } userErrors { field message } }
  }`;
const PRICE = `#graphql
  mutation Price($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { price } userErrors { field message }
    }
  }`;
const DELETE = `#graphql
  mutation Delete($input: ProductDeleteInput!) {
    productDelete(input: $input) { deletedProductId userErrors { field message } }
  }`;

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const errorsOf = (data) => Object.values(data)[0].userErrors;
  const reply = (data, message) => {
    const errors = errorsOf(data);
    return errors.length ? { ok: false, errors } : { ok: true, message };
  };
  const test = f.productId ? (await gql(FIND, { id: f.productId })).product : null;

  switch (f.intent) {
    case "create": {
      const data = await gql(CREATE, { product: { title: TEST_TITLE, status: "ACTIVE", tags: ["youtube-demo"] } });
      return { ...reply(data, "Product created"), productId: data.productCreate.product?.id };
    }
    case "rename":
      if (!test) break;
      return reply(await gql(RENAME, { product: { id: test.id, title: test.title === TEST_TITLE ? `${TEST_TITLE} v2` : TEST_TITLE } }), "Title changed");
    case "price": {
      if (!test) break;
      const v = test.variants.nodes[0];
      const price = (Number(v.price) + 5).toFixed(2);
      return reply(await gql(PRICE, { productId: test.id, variants: [{ id: v.id, price }] }), `Price → ${price}`);
    }
    case "delete":
      if (!test) break;
      return reply(await gql(DELETE, { input: { id: test.id } }), "Product deleted");
    case "fake": {
      // Anyone can POST to a public URL. Without Shopify's secret they can't sign the body → 401.
      const res = await fetch(new URL("/webhooks/catalog", process.env.SHOPIFY_APP_URL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": "products/delete",
          "X-Shopify-Shop-Domain": session.shop,
          "X-Shopify-Hmac-Sha256": "bm90LXRoZS1yZWFsLXNpZ25hdHVyZQ==",
          "X-Shopify-Webhook-Id": "fake-1",
          "X-Shopify-Event-Id": "fake-1",
          "X-Shopify-API-Version": "2026-10",
        },
        body: JSON.stringify({ id: 1 }),
      });
      return { ok: res.status === 200, message: `Fake webhook → ${res.status}`, errors: [{ message: `Fake webhook refused: ${res.status}` }] };
    }
    case "failNext":
      writeFileSync(FAIL_FLAG, "1");
      return { ok: true, message: "The next delivery will fail (500)" };
    case "clear":
      await db.webhookEvent.deleteMany({ where: { shop: session.shop } });
      return { ok: true, message: "Log cleared" };
  }
  return { ok: false, errors: [{ message: `No "${TEST_TITLE}" product yet` }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
export default function Webhooks() {
  const { events } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const busy = fetcher.state !== "idle";
  const [productId, setProductId] = useState("");
  const send = (intent) => fetcher.submit({ intent, productId }, { method: "post" });

  // Webhooks arrive in the background → re-read the log every 3 seconds
  useEffect(() => {
    const t = setInterval(() => revalidator.state === "idle" && revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [revalidator]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.productId) setProductId(fetcher.data.productId);
    if (fetcher.data.ok) shopify.toast.show(fetcher.data.message);
    else shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading="Webhooks" inlineSize="large">
      <s-section heading="Change the store">
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" loading={busy || undefined} onClick={() => send("create")}>Create test product</s-button>
          <s-button loading={busy || undefined} onClick={() => send("rename")}>Change its title</s-button>
          <s-button loading={busy || undefined} onClick={() => send("price")}>Change its price</s-button>
          <s-button tone="critical" loading={busy || undefined} onClick={() => send("delete")}>Delete it</s-button>
          <s-button loading={busy || undefined} onClick={() => send("failNext")}>Fail the next delivery</s-button>
          <s-button loading={busy || undefined} onClick={() => send("fake")}>Send a fake webhook</s-button>
        </s-stack>
      </s-section>

      <s-section heading={`Received (${events.length})`} padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Topic</s-table-header>
            <s-table-header>What happened</s-table-header>
            <s-table-header>Triggered</s-table-header>
            <s-table-header>Received</s-table-header>
            <s-table-header>Deliveries</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {events.map((e) => (
              <s-table-row key={e.eventId}>
                <s-table-cell><s-badge tone={e.topic.includes("DELETE") ? "critical" : e.topic.includes("CREATE") ? "success" : "info"}>{e.topic}</s-badge></s-table-cell>
                <s-table-cell>{e.summary}</s-table-cell>
                <s-table-cell>{e.triggeredAt ? new Date(e.triggeredAt).toLocaleTimeString() : "—"}</s-table-cell>
                <s-table-cell>{new Date(e.receivedAt).toLocaleTimeString()}</s-table-cell>
                <s-table-cell>{e.deliveries}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
