import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Episode 16: fulfillments. Scope write_merchant_managed_fulfillment_orders (orders you ship from your own locations).
// order → fulfillment orders (one per location) → line items with a remaining quantity → fulfillmentCreate
const CARRIERS = ["DHL Express", "UPS", "FedEx", "USPS", "Other"];

// ─── READ ────────────────────────────────────────────────────────────────────
const FO = `fulfillmentOrders(first: 5) {
  nodes {
    id status
    assignedLocation { name }
    lineItems(first: 10) { nodes { id remainingQuantity totalQuantity lineItem { name } } }
  }
}`;
const QUERY = `#graphql
  query Fulfillments {
    orders(first: 8, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id name displayFulfillmentStatus customer { displayName }
        ${FO}
        fulfillments(first: 5) { id status createdAt trackingInfo { company number url } fulfillmentLineItems(first: 5) { nodes { quantity lineItem { name } } } }
      }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const { data } = await (await admin.graphql(QUERY)).json();
  // The latest orders, filtered here: a search filter like fulfillment_status:partial lags a few seconds behind a new shipment
  const orders = data.orders.nodes;
  return {
    toShip: orders.map((o) => ({
      id: o.id, name: o.name, status: o.displayFulfillmentStatus, customer: o.customer?.displayName ?? "—",
      // only fulfillment orders that can still be fulfilled
      fos: o.fulfillmentOrders.nodes.filter((f) => ["OPEN", "IN_PROGRESS"].includes(f.status))
        .map((f) => ({ id: f.id, location: f.assignedLocation.name, items: f.lineItems.nodes.filter((i) => i.remainingQuantity > 0) }))
        .filter((f) => f.items.length),
    })).filter((o) => o.fos.length),
    // Shopify lists an order's fulfillments newest first; we show them in the order they were shipped
    shipped: orders.flatMap((o) => o.fulfillments.filter((f) => f.status === "SUCCESS")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((f) => ({ ...f, order: o.name }))),
  };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
const CREATE = `#graphql
  mutation Fulfill($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status trackingInfo { company number url } }
      userErrors { field message }
    }
  }`;
const TRACKING = `#graphql
  mutation Tracking($id: ID!, $tracking: FulfillmentTrackingInput!) {
    fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $tracking, notifyCustomer: false) {
      fulfillment { trackingInfo { company number url } }
      userErrors { field message }
    }
  }`;
const CANCEL = `#graphql
  mutation CancelFulfillment($id: ID!) {
    fulfillmentCancel(id: $id) { fulfillment { status } userErrors { field message } }
  }`;

// "DHL Express" → Shopify knows the carrier and builds the tracking URL itself; "Other" → we send no company
const tracking = (f) => ({ number: f.number, ...(f.company && f.company !== "Other" ? { company: f.company } : {}) });

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const reply = (result, message) => (result.userErrors.length ? { ok: false, errors: result.userErrors } : { ok: true, message });

  switch (f.intent) {
    case "fulfill": {
      // one entry per line item we ship now: its fulfillment order line item id + how many
      const items = Object.entries(f).filter(([k, v]) => k.startsWith("qty:") && Number(v) > 0)
        .map(([k, v]) => ({ id: k.slice(4), quantity: Number(v) }));
      const r = (await gql(CREATE, { fulfillment: {
        notifyCustomer: f.notify === "on",
        ...(f.number ? { trackingInfo: tracking(f) } : {}),
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: f.foId, fulfillmentOrderLineItems: items }],
      } })).fulfillmentCreate;
      return reply(r, `Shipped: ${items.reduce((n, i) => n + i.quantity, 0)} item(s)`);
    }
    case "tracking":
      return reply((await gql(TRACKING, { id: f.id, tracking: tracking(f) })).fulfillmentTrackingInfoUpdate, "Tracking updated");
    case "cancel":
      return reply((await gql(CANCEL, { id: f.id })).fulfillmentCancel, "Fulfillment cancelled");
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
export default function Fulfillments() {
  const { toShip, shipped } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show(fetcher.data.message);
    else shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (intent, extra) => (e) => {
    e.preventDefault();
    fetcher.submit({ intent, ...Object.fromEntries(new FormData(e.currentTarget)), ...extra }, { method: "post" });
  };
  const carrier = (name = "company") => (
    <s-select name={name} label="Carrier">
      {CARRIERS.map((c) => <s-option key={c} value={c}>{c}</s-option>)}
    </s-select>
  );

  return (
    <s-page heading="Fulfillments" inlineSize="large">
      {/* READY TO SHIP */}
      <s-section heading="Ready to ship">
        <s-stack gap="large">
          {toShip.length === 0 && <s-paragraph>Nothing to ship.</s-paragraph>}
          {toShip.map((o) => o.fos.map((fo) => (
            // key includes what's left, so the form resets after each shipment (fresh quantities)
            <form key={`${fo.id}-${fo.items.map((i) => i.remainingQuantity).join("-")}`} onSubmit={submit("fulfill", { foId: fo.id })}>
              <s-stack gap="small">
                <s-heading>{o.name} · {o.customer} <s-badge tone={o.status === "PARTIALLY_FULFILLED" ? "warning" : undefined}>{o.status.toLowerCase().replaceAll("_", " ")}</s-badge></s-heading>
                <s-text color="subdued">Ships from {fo.location}</s-text>
                {fo.items.map((i) => (
                  <s-grid key={i.id} gridTemplateColumns="2fr 1fr" gap="base" alignItems="center">
                    <s-text>{i.lineItem.name} · {i.remainingQuantity} of {i.totalQuantity} left</s-text>
                    <s-number-field name={`qty:${i.id}`} label={`Ship now (${i.lineItem.name})`} labelAccessibilityVisibility="exclusive" value={String(i.remainingQuantity)} min="0" max={String(i.remainingQuantity)} />
                  </s-grid>
                ))}
                <s-grid gridTemplateColumns="1fr 1fr auto" gap="base" alignItems="end">
                  {carrier()}
                  <s-text-field name="number" label="Tracking number" />
                  <s-button type="submit" variant="primary" loading={busy || undefined}>Fulfill</s-button>
                </s-grid>
                <s-checkbox name="notify" label="Email the customer" />
              </s-stack>
            </form>
          )))}
        </s-stack>
      </s-section>

      {/* SHIPPED */}
      <s-section heading="Shipped">
        <s-stack gap="base">
          {shipped.map((f) => (
            <s-box key={f.id} padding="base" border="base" borderRadius="base">
              <s-stack gap="small">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-text type="strong">{f.order}</s-text>
                  <s-text>{f.fulfillmentLineItems.nodes.map((n) => `${n.quantity} × ${n.lineItem.name}`).join(", ")}</s-text>
                  {f.trackingInfo[0] && (f.trackingInfo[0].url
                    ? <s-link href={f.trackingInfo[0].url} target="_blank">{f.trackingInfo[0].company ?? "Track"} {f.trackingInfo[0].number}</s-link>
                    : <s-text color="subdued">{f.trackingInfo[0].company ?? "No carrier"} {f.trackingInfo[0].number}</s-text>)}
                </s-stack>
                <form onSubmit={submit("tracking", { id: f.id })}>
                  <s-grid gridTemplateColumns="1fr 1fr auto auto" gap="base" alignItems="end">
                    {carrier()}
                    <s-text-field name="number" label="New tracking number" />
                    <s-button type="submit">Update tracking</s-button>
                    <s-button tone="critical" onClick={() => fetcher.submit({ intent: "cancel", id: f.id }, { method: "post" })}>Cancel</s-button>
                  </s-grid>
                </form>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
