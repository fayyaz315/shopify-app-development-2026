import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Episode 14: customers and segments. Scope write_customers (+ protected customer data: name, email, phone, address).

// ─── READ ────────────────────────────────────────────────────────────────────
const QUERY = `#graphql
  query Customers($query: String, $segmentId: ID!, $withSegment: Boolean!) {
    customersCount { count }
    customers(first: 10, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id displayName numberOfOrders tags
        defaultEmailAddress { emailAddress marketingState }
        defaultPhoneNumber { phoneNumber }
        defaultAddress { city countryCodeV2 }
      }
    }
    segments(first: 10, sortKey: CREATION_DATE, reverse: true) { nodes { id name query } }
    customerSegmentMembers(first: 10, segmentId: $segmentId) @include(if: $withSegment) {
      totalCount
      edges { node { id displayName } }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const segmentId = url.searchParams.get("segment") || "";
  const res = await admin.graphql(QUERY, { variables: { query: q || null, segmentId: segmentId || "gid://shopify/Segment/0", withSegment: !!segmentId } });
  const { data } = await res.json();
  return {
    q, segmentId, count: data.customersCount.count, segments: data.segments.nodes,
    members: data.customerSegmentMembers ?? null,
    customers: data.customers.nodes.map((c) => ({
      id: c.id, name: c.displayName, orders: Number(c.numberOfOrders), tags: c.tags,
      email: c.defaultEmailAddress?.emailAddress ?? "", subscribed: c.defaultEmailAddress?.marketingState === "SUBSCRIBED",
      phone: c.defaultPhoneNumber?.phoneNumber ?? "", city: c.defaultAddress ? `${c.defaultAddress.city}, ${c.defaultAddress.countryCodeV2}` : "",
    })),
  };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
const CREATE = `#graphql
  mutation CreateCustomer($input: CustomerInput!) {
    customerCreate(input: $input) { customer { id displayName } userErrors { field message } }
  }`;
const UPDATE = `#graphql
  mutation UpdateCustomer($input: CustomerInput!) {
    customerUpdate(input: $input) { customer { id tags } userErrors { field message } }
  }`;
const DELETE = `#graphql
  mutation DeleteCustomer($id: ID!) {
    customerDelete(input: { id: $id }) { deletedCustomerId userErrors { field message } }
  }`;
const SEGMENT = `#graphql
  mutation CreateSegment($name: String!, $query: String!) {
    segmentCreate(name: $name, query: $query) { segment { id name } userErrors { field message } }
  }`;

const list = (s) => (s || "").split(",").map((t) => t.trim()).filter(Boolean);

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const reply = (result, message, extra = {}) =>
    result.userErrors.length ? { ok: false, errors: result.userErrors } : { ok: true, message, ...extra };

  switch (f.intent) {
    case "create": {
      const input = {
        firstName: f.firstName, lastName: f.lastName, tags: list(f.tags),
        ...(f.email ? { email: f.email } : {}), ...(f.phone ? { phone: f.phone } : {}),
        // marketing consent is its own object - only send it when the customer agreed
        ...(f.subscribed === "on" && f.email ? { emailMarketingConsent: { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" } } : {}),
        ...(f.city ? { addresses: [{ city: f.city, countryCode: f.country }] } : {}),
      };
      const r = (await gql(CREATE, { input })).customerCreate;
      return reply(r, `Customer created: ${r.customer?.displayName}`);
    }
    case "tags":
      return reply((await gql(UPDATE, { input: { id: f.id, tags: list(f.tags) } })).customerUpdate, "Tags saved");
    case "delete":
      return reply((await gql(DELETE, { id: f.id })).customerDelete, "Customer deleted");
    case "segment": {
      const r = (await gql(SEGMENT, { name: f.name, query: f.query })).segmentCreate;
      return reply(r, `Segment created: ${f.name}`, { segmentId: r.segment?.id });
    }
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
export default function Customers() {
  const { q, segmentId, count, customers, segments, members } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const [, setSearch] = useSearchParams();
  const [search, setSearchText] = useState(q);
  const [editing, setEditing] = useState(null);
  const param = (key, value) => setSearch((p) => { value ? p.set(key, value) : p.delete(key); return p; });

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      setEditing(null);
      if (fetcher.data.segmentId) param("segment", fetcher.data.segmentId);
    } else shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  const send = (intent, data) => fetcher.submit({ intent, ...data }, { method: "post" });
  const submit = (intent) => (e) => { e.preventDefault(); send(intent, Object.fromEntries(new FormData(e.currentTarget))); };
  const segment = segments.find((s) => s.id === segmentId);

  return (
    <s-page heading="Customers" inlineSize="large">
      {/* LIST + SEARCH */}
      <s-section heading={`Customers (${count})`}>
        <s-stack gap="base">
          <form onSubmit={(e) => { e.preventDefault(); param("q", search); }}>
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
              <s-search-field label="Search" placeholder="tag:vip, email, name…" value={search} onInput={(e) => setSearchText(e.currentTarget.value)} />
              <s-button type="submit">Search</s-button>
            </s-grid>
          </form>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Customer</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Orders</s-table-header>
              <s-table-header>Tags</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {customers.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>{c.name}{c.city && <s-text color="subdued"> · {c.city}</s-text>}</s-table-cell>
                  <s-table-cell>{c.email || "—"} {c.subscribed && <s-badge tone="success">Subscribed</s-badge>}</s-table-cell>
                  <s-table-cell>{c.orders}</s-table-cell>
                  <s-table-cell>
                    {editing === c.id ? (
                      <form onSubmit={submit("tags")}>
                        <input type="hidden" name="id" value={c.id} />
                        <s-stack direction="inline" gap="small-200">
                          <s-text-field name="tags" label="Tags" labelAccessibilityVisibility="exclusive" value={c.tags.join(", ")} />
                          <s-button type="submit" variant="primary">Save</s-button>
                        </s-stack>
                      </form>
                    ) : (c.tags.join(", ") || "—")}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <s-button onClick={() => setEditing(editing === c.id ? null : c.id)}>Tags</s-button>
                      <s-button tone="critical" onClick={() => send("delete", { id: c.id })}>Delete</s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>

      {/* CREATE */}
      <s-section heading="Add a customer">
        <form onSubmit={submit("create")}>
          <s-stack gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field name="firstName" label="First name" />
              <s-text-field name="lastName" label="Last name" />
              <s-email-field name="email" label="Email" />
              <s-text-field name="phone" label="Phone" placeholder="+92…" />
              <s-text-field name="city" label="City" />
              <s-select name="country" label="Country">
                {[["PK", "Pakistan"], ["AE", "United Arab Emirates"], ["GB", "United Kingdom"], ["US", "United States"]].map(([c, n]) => <s-option key={c} value={c}>{n}</s-option>)}
              </s-select>
            </s-grid>
            <s-text-field name="tags" label="Tags (comma separated)" placeholder="vip, wholesale" />
            <s-checkbox name="subscribed" label="Agreed to receive marketing emails" />
            <s-button type="submit" variant="primary" loading={busy || undefined}>Add customer</s-button>
          </s-stack>
        </form>
      </s-section>

      {/* SEGMENTS */}
      <s-section heading="Segments">
        <s-stack gap="base">
          <form onSubmit={submit("segment")}>
            <s-grid gridTemplateColumns="1fr 2fr auto" gap="base" alignItems="end">
              <s-text-field name="name" label="Segment name" placeholder="VIP customers" />
              <s-text-field name="query" label="Query (ShopifyQL)" placeholder="customer_tags CONTAINS 'vip'" />
              <s-button type="submit" loading={busy || undefined}>Create segment</s-button>
            </s-grid>
          </form>
          <s-select label="Show members of" value={segmentId} onChange={(e) => param("segment", e.currentTarget.value)}>
            <s-option value="">Choose a segment</s-option>
            {segments.map((s) => <s-option key={s.id} value={s.id}>{s.name}</s-option>)}
          </s-select>
          {segment && members && (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-stack gap="small-200">
                <s-text type="strong">{segment.name}: {members.totalCount} {members.totalCount === 1 ? "customer" : "customers"}</s-text>
                <s-text color="subdued">{segment.query}</s-text>
                <s-text>{members.edges.map((e) => e.node.displayName).join(", ") || "—"}</s-text>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
