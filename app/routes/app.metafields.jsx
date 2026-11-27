import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useChange } from "../components/conditions";

// Our app keeps its product fields in ONE namespace, so they never clash with other apps.
const NAMESPACE = "specs";

// ─── READ ────────────────────────────────────────────────────────────────────
// 1. The definitions (the "columns"): name, key, type, rules.
// 2. The values (the "cells") of one product, with a compareDigest for safe saves.
const METAFIELDS_QUERY = `#graphql
  query Metafields($namespace: String!, $productId: ID!) {
    metafieldDefinitions(first: 25, ownerType: PRODUCT, namespace: $namespace) {
      nodes {
        id key name
        type { name }
        validations { name value }
        pinnedPosition
        metafieldsCount
        access { storefront }
      }
    }
    product(id: $productId) {
      id title
      metafields(first: 25, namespace: $namespace) {
        nodes { key type value jsonValue compareDigest }
      }
    }
    products(first: 10, query: "tag:youtube-demo", sortKey: TITLE) { nodes { id title } }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const first = await admin.graphql(`#graphql
    { products(first: 1, query: "tag:youtube-demo", sortKey: TITLE) { nodes { id } } }`);
  const productId = url.searchParams.get("product") || (await first.json()).data.products.nodes[0].id;

  const res = await admin.graphql(METAFIELDS_QUERY, { variables: { namespace: NAMESPACE, productId } });
  const { metafieldDefinitions, product, products } = (await res.json()).data;
  const values = Object.fromEntries(product.metafields.nodes.map((m) => [m.key, m]));

  const fields = metafieldDefinitions.nodes.map((d) => ({
    id: d.id,
    key: d.key,
    name: d.name,
    type: d.type.name,
    max: d.validations.find((v) => v.name === "max")?.value || "",
    pinned: d.pinnedPosition != null,
    storefront: d.access.storefront === "PUBLIC_READ",
    count: d.metafieldsCount,
    value: values[d.key] || null, // { value, jsonValue, compareDigest } or null = empty
  }));
  return { fields, product, products: products.nodes };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
const CREATE_DEFINITION = `#graphql
  mutation CreateDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }`;

const UPDATE_DEFINITION = `#graphql
  mutation UpdateDefinition($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id }
      userErrors { field message code }
    }
  }`;

const DELETE_DEFINITION = `#graphql
  mutation DeleteDefinition($id: ID!) {
    metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: true) {
      deletedDefinitionId
      userErrors { field message code }
    }
  }`;

// Create OR update values: one call, many fields, all or nothing.
const SET_VALUES = `#graphql
  mutation SetValues($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key value }
      userErrors { field message code }
    }
  }`;

const DELETE_VALUE = `#graphql
  mutation DeleteValue($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }`;

// The form text → the string Shopify stores for each type
const toValue = (type, text) => {
  if (type.startsWith("list.")) return JSON.stringify(text.split(",").map((s) => s.trim()).filter(Boolean));
  return text;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const run = async (query, variables) => {
    const json = await (await admin.graphql(query, { variables })).json();
    const errors = Object.values(json.data)[0].userErrors;
    return errors.length ? { ok: false, errors } : { ok: true };
  };
  const done = (result, message) => (result.ok ? { ...result, message } : result);
  const rules = f.max ? [{ name: "min", value: "0" }, { name: "max", value: f.max }] : [];

  switch (f.intent) {
    case "createDefinition":
      return done(await run(CREATE_DEFINITION, {
        definition: {
          namespace: NAMESPACE, key: f.key, name: f.name, ownerType: "PRODUCT", type: f.type,
          validations: rules,
          pin: f.pin === "on", // show it on the product page in the admin
          access: { storefront: f.storefront === "on" ? "PUBLIC_READ" : "NONE" }, // themes can read it
        },
      }), `Created ${f.name}`);
    case "updateDefinition": // the type can't change once it exists
      return done(await run(UPDATE_DEFINITION, {
        definition: { namespace: NAMESPACE, key: f.key, ownerType: "PRODUCT", name: f.name, validations: rules },
      }), `Saved ${f.name}`);
    case "deleteDefinition": // also deletes every value of it
      return done(await run(DELETE_DEFINITION, { id: f.id }), "Field deleted");
    case "setValues": {
      const fields = JSON.parse(f.fields);
      const metafields = fields
        .filter((d) => f[d.key] !== undefined && f[d.key] !== "")
        .map((d) => ({
          ownerId: f.productId, namespace: NAMESPACE, key: d.key,
          value: toValue(d.type, f[d.key]),
          compareDigest: d.digest || null, // stale page → STALE_OBJECT instead of overwriting
        }));
      return done(await run(SET_VALUES, { metafields }), "Values saved");
    }
    case "deleteValue":
      return done(await run(DELETE_VALUE, {
        metafields: [{ ownerId: f.productId, namespace: NAMESPACE, key: f.key }],
      }), "Value removed");
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const TYPES = {
  single_line_text_field: "Single line text",
  multi_line_text_field: "Multi-line text",
  number_integer: "Integer",
  "list.single_line_text_field": "List of text",
};

const shown = (f) => {
  if (!f.value) return "";
  if (f.type.startsWith("list.")) return f.value.jsonValue.join(", ");
  return f.value.value;
};

export default function Metafields() {
  const { fields, product, products } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(null); // null = create a new field
  const [type, setType] = useState("single_line_text_field");
  const [formKey, setFormKey] = useState(0);
  const busy = fetcher.state !== "idle";
  const productRef = useChange((e) => navigate(`?product=${encodeURIComponent(e.currentTarget.value)}`));
  const typeRef = useChange((e) => setType(e.currentTarget.value));

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      setFormKey((k) => k + 1);
      document.getElementById("field-modal")?.hideOverlay();
    } else {
      shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const open = (field) => {
    setEditing(field);
    setType(field ? field.type : "single_line_text_field");
    setFormKey((k) => k + 1);
    document.getElementById("field-modal").showOverlay();
  };
  const submitField = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    fetcher.submit(editing
      ? { ...data, intent: "updateDefinition", key: editing.key }
      : { ...data, intent: "createDefinition", type }, { method: "post" });
  };
  const saveValues = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    const list = fields.map((f) => ({ key: f.key, type: f.type, digest: f.value?.compareDigest }));
    fetcher.submit({ ...data, intent: "setValues", productId: product.id, fields: JSON.stringify(list) }, { method: "post" });
  };
  const formType = editing ? editing.type : type;

  return (
    <s-page heading="Metafields" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={() => open(null)}>Add field</s-button>

      {/* DEFINITIONS = the custom fields every product gets */}
      <s-section heading={`Product fields (namespace "${NAMESPACE}")`} padding="none">
        <s-table loading={busy || undefined}>
          <s-table-header-row>
            <s-table-header listSlot="primary">Field</s-table-header>
            <s-table-header>Type</s-table-header>
            <s-table-header>Products</s-table-header>
            <s-table-header>Where</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {fields.map((f) => (
              <s-table-row key={f.id}>
                <s-table-cell>
                  <s-stack gap="small-300">
                    <s-text type="strong">{f.name}</s-text>
                    <s-text color="subdued">{NAMESPACE}.{f.key}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{TYPES[f.type] || f.type}{f.max && ` (0–${f.max})`}</s-table-cell>
                <s-table-cell>{f.count}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-300">
                    {f.pinned && <s-badge>Admin</s-badge>}
                    {f.storefront && <s-badge tone="success">Storefront</s-badge>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-button-group>
                    <s-button slot="secondary-actions" onClick={() => open(f)}>Edit</s-button>
                    <s-button slot="secondary-actions" tone="critical"
                              onClick={() => fetcher.submit({ intent: "deleteDefinition", id: f.id }, { method: "post" })}>Delete</s-button>
                  </s-button-group>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* VALUES = what one product has in those fields */}
      <s-section heading="Values">
        <s-stack gap="base">
          <s-select ref={productRef} name="product" label="Product" value={product.id}>
            {products.map((p) => <s-option key={p.id} value={p.id}>{p.title}</s-option>)}
          </s-select>
          <form key={`${product.id}-${formKey}`} onSubmit={saveValues}>
            <s-stack gap="base">
              {fields.map((f) => (
                <s-grid key={f.key} gridTemplateColumns="1fr 90px" gap="small" alignItems="end">
                  <s-box>
                    {f.type === "multi_line_text_field" ? (
                      <s-text-area name={f.key} label={f.name} rows={2} value={shown(f)} />
                    ) : f.type === "number_integer" ? (
                      <s-number-field name={f.key} label={f.name} value={shown(f)} />
                    ) : (
                      <s-text-field name={f.key} label={f.name} value={shown(f)}
                                    details={f.type.startsWith("list.") ? "Separate items with commas" : undefined} />
                    )}
                  </s-box>
                  {f.value && (
                    <s-button variant="tertiary" tone="critical"
                              onClick={() => fetcher.submit({ intent: "deleteValue", productId: product.id, key: f.key }, { method: "post" })}>Remove</s-button>
                  )}
                </s-grid>
              ))}
              <s-button type="submit" variant="primary" loading={busy || undefined}>Save values</s-button>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      {/* CREATE or EDIT a field */}
      <s-modal id="field-modal" heading={editing ? `Edit ${editing.name}` : "Add field"}>
        <form id="field-form" key={formKey} onSubmit={submitField}>
          <s-stack gap="base">
            <s-text-field name="name" label="Name" required value={editing?.name || ""} />
            {!editing && (
              <>
                <s-text-field name="key" label="Key" required placeholder="care_guide" details="Lowercase, numbers and _ only" />
                <s-select ref={typeRef} name="type" label="Type" value={type}>
                  {Object.entries(TYPES).map(([v, l]) => <s-option key={v} value={v}>{l}</s-option>)}
                </s-select>
              </>
            )}
            {formType === "number_integer" && (
              <s-number-field name="max" label="Maximum (optional)" min={1} value={editing?.max || ""} />
            )}
            {!editing && (
              <>
                <s-checkbox name="pin" label="Show on the product page in the admin" checked />
                <s-checkbox name="storefront" label="Themes can read it on the storefront" />
              </>
            )}
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("field-form").requestSubmit()}>
          {editing ? "Save" : "Add field"}
        </s-button>
        <s-button slot="secondary-actions" commandFor="field-modal" command="--hide">Cancel</s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
