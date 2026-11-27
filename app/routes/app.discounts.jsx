import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useChange } from "../components/conditions";

// ─── READ ────────────────────────────────────────────────────────────────────
// One list for every kind of discount (API 2026-10): discountNodes.
// codeDiscountNodes and automaticDiscountNodes are deprecated.
const DISCOUNTS_QUERY = `#graphql
  query Discounts($query: String) {
    discountNodes(first: 25, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        discount {
          __typename
          ... on DiscountCodeBasic { title status summary codes(first: 1) { nodes { code } } ...Percent }
          ... on DiscountCodeBxgy { title status summary codes(first: 1) { nodes { code } } }
          ... on DiscountCodeFreeShipping { title status summary codes(first: 1) { nodes { code } } }
          ... on DiscountAutomaticBasic { title status summary ...AutoPercent }
          ... on DiscountAutomaticBxgy { title status summary }
          ... on DiscountAutomaticFreeShipping { title status summary }
          ... on DiscountCodeApp { title status }
          ... on DiscountAutomaticApp { title status }
        }
      }
    }
    products(first: 10, query: "tag:youtube-demo", sortKey: TITLE) { nodes { id title } }
  }
  fragment Percent on DiscountCodeBasic { customerGets { value { ... on DiscountPercentage { percentage } } } }
  fragment AutoPercent on DiscountAutomaticBasic { customerGets { value { ... on DiscountPercentage { percentage } } } }`;

// Search syntax of discountNodes: method, status, discount_type, title …
const FILTERS = {
  all: "",
  code: "method:code",
  automatic: "method:automatic",
  active: "status:active",
  expired: "status:expired",
};

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const show = new URL(request.url).searchParams.get("show") || "all";
  const res = await admin.graphql(DISCOUNTS_QUERY, { variables: { query: FILTERS[show] } });
  const { discountNodes, products } = (await res.json()).data;

  const rows = discountNodes.nodes.map(({ id, discount: d }) => ({
    id,
    title: d.title,
    code: d.codes?.nodes[0]?.code || "",
    automatic: id.includes("DiscountAutomaticNode"),
    kind: d.__typename.replace(/^Discount(Code|Automatic)/, ""), // Basic | Bxgy | FreeShipping | App
    status: d.status,
    summary: d.summary || "Made by another app",
    percent: d.customerGets?.value?.percentage != null ? Math.round(d.customerGets.value.percentage * 100) : null,
  }));
  return { rows, products: products.nodes, show };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
// One create + one update mutation per discount kind and method (code or automatic).
const CREATE = {
  "code-Basic": ["discountCodeBasicCreate", "basicCodeDiscount", "DiscountCodeBasicInput"],
  "code-Bxgy": ["discountCodeBxgyCreate", "bxgyCodeDiscount", "DiscountCodeBxgyInput"],
  "code-FreeShipping": ["discountCodeFreeShippingCreate", "freeShippingCodeDiscount", "DiscountCodeFreeShippingInput"],
  "automatic-Basic": ["discountAutomaticBasicCreate", "automaticBasicDiscount", "DiscountAutomaticBasicInput"],
  "automatic-Bxgy": ["discountAutomaticBxgyCreate", "automaticBxgyDiscount", "DiscountAutomaticBxgyInput"],
  "automatic-FreeShipping": ["discountAutomaticFreeShippingCreate", "freeShippingAutomaticDiscount", "DiscountAutomaticFreeShippingInput"],
};
const createMutation = ([name, arg, type]) => `#graphql
  mutation Create($input: ${type}!) {
    ${name}(${arg}: $input) { userErrors { field message code } }
  }`;
const updateMutation = ([name, arg, type]) => `#graphql
  mutation Update($id: ID!, $input: ${type}!) {
    ${name.replace("Create", "Update")}(id: $id, ${arg}: $input) { userErrors { field message code } }
  }`;
const simple = (name) => `#graphql
  mutation Run($id: ID!) { ${name}(id: $id) { userErrors { field message code } } }`;

// The form → the input Shopify expects for each kind
const inputFor = (f) => {
  const input = { title: f.title };
  if (f.method === "code") {
    input.code = f.code;
    input.context = { all: "ALL" }; // who can use it (required for codes; customerSelection is deprecated)
  }
  if (f.kind === "Basic" && f.percent) {
    input.customerGets = {
      value: { percentage: Number(f.percent) / 100 }, // 20 % → 0.2 (Shopify wants 0.0 – 1.0)
      items: { all: true },
    };
  }
  if (f.kind === "Bxgy" && f.productId) {
    input.customerBuys = { value: { quantity: f.buy }, items: { products: { productsToAdd: [f.productId] } } };
    input.customerGets = {
      value: { discountOnQuantity: { quantity: f.get, effect: { percentage: 1 } } }, // 100 % off = free
      items: { products: { productsToAdd: [f.productId] } },
    };
  }
  if (f.kind === "FreeShipping" && f.method !== "update") input.destination = { all: true };
  if (f.minimum) input.minimumRequirement = { subtotal: { greaterThanOrEqualToSubtotal: f.minimum } };
  return input;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const run = async (query, variables) => {
    const json = await (await admin.graphql(query, { variables })).json();
    const errors = Object.values(json.data)[0].userErrors;
    return errors.length ? { ok: false, errors } : { ok: true };
  };
  const method = f.automatic === "true" ? "automatic" : "code";
  const done = (result, message) => (result.ok ? { ...result, message } : result);

  switch (f.intent) {
    case "create": {
      const input = { ...inputFor(f), startsAt: new Date().toISOString() };
      return done(await run(createMutation(CREATE[`${f.method}-${f.kind}`]), { input }), `Created ${f.title}`);
    }
    case "update": // the same input shape, only the fields you change
      return done(await run(updateMutation(CREATE[`${method}-${f.kind}`]), {
        id: f.id, input: inputFor({ ...f, method: "update" }),
      }), `Saved ${f.title}`);
    case "deactivate": // ends it now (status EXPIRED); activate clears the end date
      return done(await run(simple(method === "code" ? "discountCodeDeactivate" : "discountAutomaticDeactivate"), { id: f.id }), "Discount deactivated");
    case "activate":
      return done(await run(simple(method === "code" ? "discountCodeActivate" : "discountAutomaticActivate"), { id: f.id }), "Discount activated");
    case "delete":
      return done(await run(simple(method === "code" ? "discountCodeDelete" : "discountAutomaticDelete"), { id: f.id }), "Discount deleted");
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const KINDS = { Basic: "Percentage off", Bxgy: "Buy X get Y", FreeShipping: "Free shipping", App: "App discount" };
const TONES = { ACTIVE: "success", SCHEDULED: "info", EXPIRED: undefined };

export default function Discounts() {
  const { rows, products, show } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(null); // null = create a new discount
  const [method, setMethod] = useState("code");
  const [kind, setKind] = useState("Basic");
  const [formKey, setFormKey] = useState(0);
  const busy = fetcher.state !== "idle";
  const showRef = useChange((e) => navigate(`?show=${e.currentTarget.value}`));
  const methodRef = useChange((e) => setMethod(e.currentTarget.value));
  const kindRef = useChange((e) => setKind(e.currentTarget.value));

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      setFormKey((k) => k + 1);
      document.getElementById("discount-modal")?.hideOverlay();
    } else {
      shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const open = (row) => {
    setEditing(row);
    if (!row) { setMethod("code"); setKind("Basic"); }
    setFormKey((k) => k + 1);
    document.getElementById("discount-modal").showOverlay();
  };
  const post = (intent, row) => fetcher.submit({ intent, id: row.id, automatic: String(row.automatic) }, { method: "post" });
  const submit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    fetcher.submit(editing
      ? { ...data, intent: "update", id: editing.id, kind: editing.kind, automatic: String(editing.automatic) }
      : { ...data, intent: "create", method, kind }, { method: "post" });
  };
  const formKind = editing ? editing.kind : kind;

  return (
    <s-page heading="Discounts" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={() => open(null)}>Create discount</s-button>

      <s-section padding="none">
        <s-box padding="base">
          <s-select ref={showRef} name="show" label="Show" value={show}>
            <s-option value="all">All discounts</s-option>
            <s-option value="code">Codes</s-option>
            <s-option value="automatic">Automatic</s-option>
            <s-option value="active">Active</s-option>
            <s-option value="expired">Expired</s-option>
          </s-select>
        </s-box>
        <s-table loading={busy || undefined}>
          <s-table-header-row>
            <s-table-header listSlot="primary">Title</s-table-header>
            <s-table-header>Method</s-table-header>
            <s-table-header>Type</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>
                  <s-stack gap="small-300">
                    <s-text type="strong">{r.title}</s-text>
                    <s-text color="subdued">{r.summary}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{r.automatic ? "Automatic" : <s-badge>{r.code}</s-badge>}</s-table-cell>
                <s-table-cell>{KINDS[r.kind]}</s-table-cell>
                <s-table-cell><s-badge tone={TONES[r.status]}>{r.status.toLowerCase()}</s-badge></s-table-cell>
                <s-table-cell>
                  {r.kind !== "App" && (
                    <s-button-group>
                      <s-button slot="secondary-actions" onClick={() => open(r)}>Edit</s-button>
                      {r.status === "EXPIRED"
                        ? <s-button slot="secondary-actions" onClick={() => post("activate", r)}>Activate</s-button>
                        : <s-button slot="secondary-actions" onClick={() => post("deactivate", r)}>Deactivate</s-button>}
                      <s-button slot="secondary-actions" tone="critical" onClick={() => post("delete", r)}>Delete</s-button>
                    </s-button-group>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* CREATE or EDIT */}
      <s-modal id="discount-modal" heading={editing ? `Edit ${editing.title}` : "Create discount"}>
        <form id="discount-form" key={formKey} onSubmit={submit}>
          <s-stack gap="base">
            {!editing && (
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-select ref={methodRef} name="method" label="Method" value={method}>
                  <s-option value="code">Discount code</s-option>
                  <s-option value="automatic">Automatic</s-option>
                </s-select>
                <s-select ref={kindRef} name="kind" label="Type" value={kind}>
                  <s-option value="Basic">Percentage off</s-option>
                  <s-option value="Bxgy">Buy X get Y</s-option>
                  <s-option value="FreeShipping">Free shipping</s-option>
                </s-select>
              </s-grid>
            )}
            <s-text-field name="title" label="Title" required value={editing?.title || ""} />
            {!editing && method === "code" && (
              <s-text-field name="code" label="Code" required placeholder="SAVE20" />
            )}
            {formKind === "Basic" && (
              <s-number-field name="percent" label="Percentage off" suffix="%" required min={1} max={100} value={String(editing?.percent ?? 20)} />
            )}
            {formKind === "Bxgy" && !editing && (
              <>
                <s-select name="productId" label="Product">
                  {products.map((p) => <s-option key={p.id} value={p.id}>{p.title}</s-option>)}
                </s-select>
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-number-field name="buy" label="Customer buys" required min={1} value="2" />
                  <s-number-field name="get" label="Gets free" required min={1} value="1" />
                </s-grid>
              </>
            )}
            {formKind !== "Bxgy" && !editing && (
              <s-money-field name="minimum" label="Minimum purchase (optional)" />
            )}
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("discount-form").requestSubmit()}>
          {editing ? "Save" : "Create discount"}
        </s-button>
        <s-button slot="secondary-actions" commandFor="discount-modal" command="--hide">Cancel</s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
