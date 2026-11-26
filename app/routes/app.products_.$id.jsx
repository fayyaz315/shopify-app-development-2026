import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// ─── READ ────────────────────────────────────────────────────────────────────
// One product with its options (Size, Color…) and every variant (one row per combination).
const PRODUCT_QUERY = `#graphql
  query Product($id: ID!) {
    product(id: $id) {
      id
      title
      options { id name values }
      variants(first: 100) {
        nodes { id title price sku inventoryQuantity }
      }
    }
  }`;

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(PRODUCT_QUERY, {
    variables: { id: `gid://shopify/Product/${params.id}` },
  });
  const { data } = await response.json();
  if (!data.product) throw new Response("Product not found", { status: 404 });
  return { product: data.product };
};

// ─── OPTIONS + VARIANTS: CREATE / UPDATE / DELETE ────────────────────────────
const OPTIONS_CREATE = `#graphql
  mutation AddOption($productId: ID!, $options: [OptionCreateInput!]!) {
    productOptionsCreate(productId: $productId, options: $options, variantStrategy: CREATE) {
      product { variantsCount { count } }
      userErrors { field message code }
    }
  }`;
const OPTIONS_DELETE = `#graphql
  mutation DeleteOption($productId: ID!, $options: [ID!]!) {
    productOptionsDelete(productId: $productId, options: $options) {
      deletedOptionsIds
      userErrors { field message code }
    }
  }`;
const VARIANTS_CREATE = `#graphql
  mutation AddVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id title }
      userErrors { field message code }
    }
  }`;
const VARIANTS_UPDATE = `#graphql
  mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price sku }
      userErrors { field message code }
    }
  }`;
const VARIANTS_DELETE = `#graphql
  mutation DeleteVariants($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { variantsCount { count } }
      userErrors { field message code }
    }
  }`;

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const form = Object.fromEntries(await request.formData());
  const productId = `gid://shopify/Product/${params.id}`;
  const run = async (query, variables) =>
    Object.values((await (await admin.graphql(query, { variables })).json()).data)[0];
  const done = (result, message) =>
    result.userErrors.length ? { ok: false, errors: result.userErrors } : { ok: true, message };

  if (form.intent === "addOption") {
    // "Red, Blue" → [{ name: "Red" }, { name: "Blue" }]; CREATE makes a variant for every new combination
    const values = form.values.split(",").map((v) => ({ name: v.trim() })).filter((v) => v.name);
    const result = await run(OPTIONS_CREATE, { productId, options: [{ name: form.name, values }] });
    return done(result, `${form.name} added · ${result.product?.variantsCount.count} variants`);
  }

  if (form.intent === "deleteOption") {
    return done(await run(OPTIONS_DELETE, { productId, options: [form.optionId] }), "Option deleted");
  }

  if (form.intent === "addVariant") {
    const optionValues = JSON.parse(form.optionValues); // [{ optionName: "Size", name: "XL" }, …]
    const variants = [{ optionValues, price: form.price, inventoryItem: { sku: form.sku } }];
    return done(await run(VARIANTS_CREATE, { productId, variants }), "Variant added");
  }

  if (form.intent === "updateVariants") {
    // one call for every row: [{ id, price, inventoryItem: { sku } }, …]
    const variants = JSON.parse(form.variants).map((v) => ({
      id: v.id, price: v.price, inventoryItem: { sku: v.sku },
    }));
    return done(await run(VARIANTS_UPDATE, { productId, variants }), `${variants.length} variants saved`);
  }

  if (form.intent === "deleteVariants") {
    const variantsIds = JSON.parse(form.ids);
    return done(await run(VARIANTS_DELETE, { productId, variantsIds }), `${variantsIds.length} deleted`);
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const rowsFrom = (product) =>
  product.variants.nodes.map((v) => ({ id: v.id, price: v.price, sku: v.sku || "" }));

export default function ProductVariants() {
  const { product } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [rows, setRows] = useState(() => rowsFrom(product)); // editable price + SKU per variant
  const [selected, setSelected] = useState([]);
  const [allPrice, setAllPrice] = useState("");
  const [formKey, setFormKey] = useState(0); // new key = empty forms after each save
  const busy = fetcher.state !== "idle";
  const hasOptions = product.options[0]?.name !== "Title"; // "Title / Default Title" = no real options yet

  // fresh rows after every save (the loader re-runs automatically)
  useEffect(() => { setRows(rowsFrom(product)); setSelected([]); }, [product]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      setFormKey((k) => k + 1);
      ["option-modal", "variant-modal", "delete-modal"].forEach((id) => document.getElementById(id)?.hideOverlay());
    } else {
      shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const post = (data) => fetcher.submit(data, { method: "post" });
  const setRow = (id, key, value) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [key]: value } : r)));
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const formData = (e) => Object.fromEntries(new FormData(e.currentTarget));

  const addOption = (e) => { e.preventDefault(); post({ intent: "addOption", ...formData(e) }); };
  const addVariant = (e) => {
    e.preventDefault();
    const f = formData(e);
    const optionValues = product.options.map((o) => ({ optionName: o.name, name: f[`option-${o.name}`] }));
    post({ intent: "addVariant", price: f.price, sku: f.sku, optionValues: JSON.stringify(optionValues) });
  };

  return (
    <s-page heading={product.title} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/products">Products</s-link>
      <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                onClick={() => post({ intent: "updateVariants", variants: JSON.stringify(rows) })}>
        Save variants
      </s-button>

      {/* OPTIONS: Size, Color… */}
      <s-section heading="Options">
        <s-stack gap="base">
          {!hasOptions && <s-paragraph>No options yet: this product has one “Default Title” variant.</s-paragraph>}
          {hasOptions && product.options.map((o) => (
            <s-stack key={o.id} direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong">{o.name}</s-text>
              {o.values.map((v) => <s-badge key={v}>{v}</s-badge>)}
              <s-button variant="tertiary" tone="critical" icon="delete" accessibilityLabel={`Delete ${o.name}`}
                        onClick={() => post({ intent: "deleteOption", optionId: o.id })} />
            </s-stack>
          ))}
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => document.getElementById("option-modal").showOverlay()}>Add option</s-button>
            {hasOptions && <s-button onClick={() => document.getElementById("variant-modal").showOverlay()}>Add variant</s-button>}
          </s-stack>
        </s-stack>
      </s-section>

      {/* VARIANTS: one row per combination, price + SKU editable, saved in ONE bulk call */}
      <s-section heading={`Variants (${product.variants.nodes.length})`} padding="none">
        <s-grid gridTemplateColumns="240px auto auto 1fr" gap="base" alignItems="end" padding="base">
          <s-money-field label="Price for all variants" value={allPrice} placeholder="0.00"
                         onInput={(e) => setAllPrice(e.currentTarget.value)} />
          <s-button onClick={() => allPrice && setRows((rs) => rs.map((r) => ({ ...r, price: allPrice })))}>
            Apply to all
          </s-button>
          <s-button tone="critical" disabled={!selected.length || undefined}
                    onClick={() => document.getElementById("delete-modal").showOverlay()}>
            Delete selected ({selected.length})
          </s-button>
        </s-grid>
        <s-table loading={busy || undefined}>
          <s-table-header-row>
            <s-table-header></s-table-header>
            <s-table-header listSlot="primary">Variant</s-table-header>
            <s-table-header format="currency">Price</s-table-header>
            <s-table-header>SKU</s-table-header>
            <s-table-header format="numeric">Inventory</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {product.variants.nodes.map((v) => {
              const row = rows.find((r) => r.id === v.id) || v;
              return (
                <s-table-row key={v.id}>
                  <s-table-cell>
                    <s-checkbox accessibilityLabel={`Select ${v.title}`} checked={selected.includes(v.id) || undefined}
                                onChange={() => toggle(v.id)} />
                  </s-table-cell>
                  <s-table-cell><s-text type="strong">{v.title}</s-text></s-table-cell>
                  <s-table-cell>
                    <s-money-field label="Price" labelAccessibilityVisibility="exclusive" value={row.price}
                                   onInput={(e) => setRow(v.id, "price", e.currentTarget.value)} />
                  </s-table-cell>
                  <s-table-cell>
                    <s-text-field label="SKU" labelAccessibilityVisibility="exclusive" value={row.sku}
                                  onInput={(e) => setRow(v.id, "sku", e.currentTarget.value)} />
                  </s-table-cell>
                  <s-table-cell>{v.inventoryQuantity}</s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-section>

      {/* ADD OPTION */}
      <s-modal id="option-modal" heading="Add option">
        <form id="option-form" key={formKey} onSubmit={addOption}>
          <s-stack gap="base">
            <s-text-field name="name" label="Option name" placeholder="Size" required />
            <s-text-field name="values" label="Values" placeholder="S, M, L" details="Separate values with commas" required />
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("option-form").requestSubmit()}>Add option</s-button>
        <s-button slot="secondary-actions" commandFor="option-modal" command="--hide">Cancel</s-button>
      </s-modal>

      {/* ADD VARIANT: one value per option (a new value like "XL" is added to the option) */}
      <s-modal id="variant-modal" heading="Add variant">
        <form id="variant-form" key={formKey} onSubmit={addVariant}>
          <s-stack gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              {product.options.map((o) => (
                <s-text-field key={o.id} name={`option-${o.name}`} label={o.name} placeholder={o.values[0]} required />
              ))}
              <s-money-field name="price" label="Price" placeholder="0.00" />
              <s-text-field name="sku" label="SKU" />
            </s-grid>
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("variant-form").requestSubmit()}>Add variant</s-button>
        <s-button slot="secondary-actions" commandFor="variant-modal" command="--hide">Cancel</s-button>
      </s-modal>

      {/* DELETE selected variants */}
      <s-modal id="delete-modal" heading="Delete variants?">
        <s-paragraph>{selected.length} variant(s) will be deleted from “{product.title}”. This can’t be undone.</s-paragraph>
        <s-button slot="primary-action" variant="primary" tone="critical" loading={busy || undefined}
                  onClick={() => post({ intent: "deleteVariants", ids: JSON.stringify(selected) })}>Delete</s-button>
        <s-button slot="secondary-actions" commandFor="delete-modal" command="--hide">Cancel</s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
