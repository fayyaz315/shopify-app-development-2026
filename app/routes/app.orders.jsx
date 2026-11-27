import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Episode 15: draft orders → orders. Scopes write_draft_orders, write_orders.
// Without read_all_orders an app only sees orders from the last 60 days.

// ─── READ ────────────────────────────────────────────────────────────────────
const QUERY = `#graphql
  query Orders {
    shop { currencyCode }
    orders(first: 8, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id name createdAt cancelledAt tags
        displayFinancialStatus displayFulfillmentStatus
        customer { displayName }
        totalPriceSet { shopMoney { amount currencyCode } }
      }
    }
    draftOrders(first: 5, reverse: true, query: "status:open") {
      nodes { id name createdAt invoiceUrl customer { displayName } totalPriceSet { shopMoney { amount } } }
    }
    customers(first: 10, sortKey: NAME) { nodes { id displayName } }
    products(first: 20, sortKey: TITLE) { nodes { title variants(first: 1) { nodes { id price } } } }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const { data } = await (await admin.graphql(QUERY)).json();
  return {
    currency: data.shop.currencyCode,
    orders: data.orders.nodes, drafts: data.draftOrders.nodes, customers: data.customers.nodes,
    products: data.products.nodes.map((p) => ({ title: p.title, variantId: p.variants.nodes[0]?.id, price: p.variants.nodes[0]?.price })),
  };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
const TOTALS = `subtotalPriceSet { shopMoney { amount } } totalDiscountsSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } } totalPriceSet { shopMoney { amount } }`;
const CALCULATE = `#graphql
  mutation Calculate($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) { calculatedDraftOrder { ${TOTALS} } userErrors { field message } }
  }`;
const CREATE = `#graphql
  mutation CreateDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } }
  }`;
const COMPLETE = `#graphql
  mutation Complete($id: ID!) {
    draftOrderComplete(id: $id, paymentPending: true) {
      draftOrder { order { id name } }
      userErrors { field message }
    }
  }`;
const DELETE_DRAFT = `#graphql
  mutation DeleteDraft($id: ID!) {
    draftOrderDelete(input: { id: $id }) { deletedId userErrors { field message } }
  }`;
const PAID = `#graphql
  mutation Paid($id: ID!) {
    orderMarkAsPaid(input: { id: $id }) { order { displayFinancialStatus } userErrors { field message } }
  }`;
const CANCEL = `#graphql
  mutation Cancel($id: ID!) {
    orderCancel(orderId: $id, reason: CUSTOMER, refundMethod: { originalPaymentMethodsRefund: true }, restock: true, notifyCustomer: false) {
      job { id }
      orderCancelUserErrors { field message code }
    }
  }`;

// The form → one DraftOrderInput: a product line, an optional custom line, an optional % discount and a shipping line
const draftInput = (f) => ({
  customerId: f.customerId || undefined,
  tags: ["phone-order"],
  lineItems: [
    { variantId: f.variantId, quantity: Number(f.quantity || 1) },
    ...(f.customTitle ? [{ title: f.customTitle, quantity: 1, originalUnitPriceWithCurrency: { amount: Number(f.customPrice || 0), currencyCode: f.currency }, requiresShipping: false }] : []),
  ],
  ...(f.discount ? { appliedDiscount: { title: `Phone order ${f.discount}%`, value: Number(f.discount), valueType: "PERCENTAGE" } } : {}),
  ...(f.shipping ? { shippingLine: { title: "Courier", priceWithCurrency: { amount: Number(f.shipping), currencyCode: f.currency } } } : {}),
});

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const reply = (result, message, extra = {}) =>
    result.userErrors.length ? { ok: false, errors: result.userErrors } : { ok: true, message, ...extra };

  switch (f.intent) {
    case "calculate": {
      const r = (await gql(CALCULATE, { input: draftInput(f) })).draftOrderCalculate;
      return reply(r, "Totals calculated", { totals: r.calculatedDraftOrder });
    }
    case "create": {
      const r = (await gql(CREATE, { input: draftInput(f) })).draftOrderCreate;
      return reply(r, `Draft order ${r.draftOrder?.name} created`);
    }
    case "complete": {
      const r = (await gql(COMPLETE, { id: f.id })).draftOrderComplete;
      return reply(r, `Order ${r.draftOrder?.order?.name} created`);
    }
    case "deleteDraft":
      return reply((await gql(DELETE_DRAFT, { id: f.id })).draftOrderDelete, "Draft deleted");
    case "paid":
      return reply((await gql(PAID, { id: f.id })).orderMarkAsPaid, "Marked as paid");
    case "cancel": {
      const r = (await gql(CANCEL, { id: f.id })).orderCancel;
      return r.orderCancelUserErrors.length ? { ok: false, errors: r.orderCancelUserErrors } : { ok: true, message: "Cancelling… (a background job)" };
    }
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const money = (m) => `$${Number(m).toFixed(2)}`;
const tone = (s) => ({ PAID: "success", PENDING: "warning", REFUNDED: "info", VOIDED: "info" })[s];

export default function Orders() {
  const { currency, orders, drafts, customers, products } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const [totals, setTotals] = useState(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      setTotals(fetcher.data.totals ?? null);
    } else shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  const send = (intent, data) => fetcher.submit({ intent, ...data }, { method: "post" });
  const draft = (intent) => (e) => {
    e.preventDefault();
    send(intent, { ...Object.fromEntries(new FormData(document.getElementById("draft"))), currency });
  };

  return (
    <s-page heading="Orders" inlineSize="large">
      {/* NEW DRAFT ORDER (a phone order) */}
      <s-section heading="New draft order">
        <form id="draft" onSubmit={draft("create")}>
          <s-stack gap="base">
            <s-grid gridTemplateColumns="2fr 2fr 1fr" gap="base">
              <s-select name="customerId" label="Customer">
                {customers.map((c) => <s-option key={c.id} value={c.id}>{c.displayName}</s-option>)}
              </s-select>
              <s-select name="variantId" label="Product">
                {products.filter((p) => p.variantId).map((p) => <s-option key={p.variantId} value={p.variantId}>{p.title} · {money(p.price)}</s-option>)}
              </s-select>
              <s-number-field name="quantity" label="Quantity" value="1" min="1" />
            </s-grid>
            <s-grid gridTemplateColumns="2fr 1fr 1fr 1fr" gap="base">
              <s-text-field name="customTitle" label="Custom item (optional)" placeholder="Gift wrapping" />
              <s-number-field name="customPrice" label="Its price" min="0" />
              <s-number-field name="discount" label="Discount %" min="0" max="100" />
              <s-number-field name="shipping" label="Shipping" min="0" />
            </s-grid>
            <s-stack direction="inline" gap="base">
              <s-button onClick={draft("calculate")} loading={busy || undefined}>Calculate</s-button>
              <s-button type="submit" variant="primary" loading={busy || undefined}>Create draft order</s-button>
            </s-stack>
            {totals && (
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-stack direction="inline" gap="large">
                  <s-text>Subtotal {money(totals.subtotalPriceSet.shopMoney.amount)}</s-text>
                  <s-text>Discount −{money(totals.totalDiscountsSet.shopMoney.amount)}</s-text>
                  <s-text>Shipping {money(totals.totalShippingPriceSet.shopMoney.amount)}</s-text>
                  <s-text>Tax {money(totals.totalTaxSet.shopMoney.amount)}</s-text>
                  <s-text type="strong">Total {money(totals.totalPriceSet.shopMoney.amount)}</s-text>
                </s-stack>
              </s-box>
            )}
          </s-stack>
        </form>
      </s-section>

      {/* OPEN DRAFTS */}
      <s-section heading="Open draft orders" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Draft</s-table-header>
            <s-table-header>Customer</s-table-header>
            <s-table-header>Total</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {drafts.map((d) => (
              <s-table-row key={d.id}>
                <s-table-cell>{d.name}</s-table-cell>
                <s-table-cell>{d.customer?.displayName ?? "—"}</s-table-cell>
                <s-table-cell>{money(d.totalPriceSet.shopMoney.amount)}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200">
                    <s-button variant="primary" onClick={() => send("complete", { id: d.id })}>Create order</s-button>
                    <s-link href={d.invoiceUrl} target="_blank">Invoice page</s-link>
                    <s-button tone="critical" onClick={() => send("deleteDraft", { id: d.id })}>Delete</s-button>
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* ORDERS */}
      <s-section heading="Latest orders (last 60 days)" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Order</s-table-header>
            <s-table-header>Customer</s-table-header>
            <s-table-header>Payment</s-table-header>
            <s-table-header>Fulfillment</s-table-header>
            <s-table-header>Total</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {orders.map((o) => (
              <s-table-row key={o.id}>
                <s-table-cell>{o.name} {o.cancelledAt && <s-badge tone="critical">Cancelled</s-badge>}</s-table-cell>
                <s-table-cell>{o.customer?.displayName ?? "—"}</s-table-cell>
                <s-table-cell><s-badge tone={tone(o.displayFinancialStatus)}>{o.displayFinancialStatus.toLowerCase().replaceAll("_", " ")}</s-badge></s-table-cell>
                <s-table-cell>{o.displayFulfillmentStatus.toLowerCase().replaceAll("_", " ")}</s-table-cell>
                <s-table-cell>{money(o.totalPriceSet.shopMoney.amount)}</s-table-cell>
                <s-table-cell>
                  {!o.cancelledAt && (
                    <s-stack direction="inline" gap="small-200">
                      {o.displayFinancialStatus === "PENDING" && <s-button onClick={() => send("paid", { id: o.id })}>Mark as paid</s-button>}
                      <s-button tone="critical" onClick={() => send("cancel", { id: o.id })}>Cancel</s-button>
                    </s-stack>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
