import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Our own content type. Products point at an entry through a metafield (episode 7).
const TYPE = "size_guide";
const FITS = ["Slim", "Regular", "Relaxed"];
const LINK = { namespace: "specs", key: "size_guide" };

// ─── READ ────────────────────────────────────────────────────────────────────
// 1. Does the type exist?  2. Its entries.  3. Which entry each product uses.
const METAOBJECTS_QUERY = `#graphql
  query SizeGuides($type: String!) {
    metaobjectDefinitionByType(type: $type) { id metaobjectsCount }
    metaobjects(type: $type, first: 25) {
      nodes {
        id handle displayName
        fit: field(key: "fit") { value }
        sizes: field(key: "sizes") { jsonValue }
        notes: field(key: "notes") { value }
        capabilities { publishable { status } }
        referencedBy(first: 25) { nodes { referencer { ... on Product { id } } } }
      }
    }
    products(first: 10, query: "tag:youtube-demo", sortKey: TITLE) {
      nodes {
        id title
        guide: metafield(namespace: "specs", key: "size_guide") {
          reference { ... on Metaobject { id displayName } }
        }
      }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const res = await admin.graphql(METAOBJECTS_QUERY, { variables: { type: TYPE } });
  const { metaobjectDefinitionByType, metaobjects, products } = (await res.json()).data;

  const guides = metaobjects.nodes.map((m) => ({
    id: m.id,
    title: m.displayName,
    handle: m.handle,
    fit: m.fit?.value || "",
    sizes: m.sizes?.jsonValue || [],
    notes: m.notes?.value || "",
    active: m.capabilities.publishable?.status === "ACTIVE",
    usedBy: m.referencedBy.nodes.length, // products that point at it
  }));
  return {
    ready: Boolean(metaobjectDefinitionByType), // null = the type doesn't exist yet
    guides,
    products: products.nodes.map((p) => ({ id: p.id, title: p.title, guide: p.guide?.reference || null })),
  };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
// Once per store: the type (fields + rules), and the product metafield that points at it.
const CREATE_TYPE = `#graphql
  mutation CreateType($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id }
      userErrors { field message code }
    }
  }`;

const CREATE_LINK = `#graphql
  mutation CreateLink($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }`;

const CREATE_ENTRY = `#graphql
  mutation CreateEntry($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { handle }
      userErrors { field message code }
    }
  }`;

const UPDATE_ENTRY = `#graphql
  mutation UpdateEntry($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject { handle }
      userErrors { field message code }
    }
  }`;

const DELETE_ENTRY = `#graphql
  mutation DeleteEntry($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }`;

const ASSIGN = `#graphql
  mutation Assign($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key }
      userErrors { field message code }
    }
  }`;

// The form → the fields Shopify expects (every value is a string, lists are JSON)
const fieldsFrom = (f) => [
  { key: "title", value: f.title },
  { key: "fit", value: f.fit },
  { key: "sizes", value: JSON.stringify(f.sizes.split(",").map((s) => s.trim()).filter(Boolean)) },
  { key: "notes", value: f.notes },
];
const status = (f) => ({ publishable: { status: f.active === "on" ? "ACTIVE" : "DRAFT" } });

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const run = async (query, variables) => {
    const json = await (await admin.graphql(query, { variables })).json();
    const errors = Object.values(json.data)[0].userErrors;
    return errors.length ? { ok: false, errors } : { ok: true };
  };
  const done = (result, message) => (result.ok ? { ...result, message } : result);

  switch (f.intent) {
    case "setup": {
      const type = await run(CREATE_TYPE, {
        definition: {
          type: TYPE, name: "Size guide", displayNameKey: "title",
          access: { storefront: "PUBLIC_READ" },
          capabilities: { publishable: { enabled: true } }, // entries are Draft or Active
          fieldDefinitions: [
            { key: "title", name: "Title", type: "single_line_text_field", required: true },
            { key: "fit", name: "Fit", type: "single_line_text_field",
              validations: [{ name: "choices", value: JSON.stringify(FITS) }] },
            { key: "sizes", name: "Sizes", type: "list.single_line_text_field" },
            { key: "notes", name: "Notes", type: "multi_line_text_field" },
          ],
        },
      });
      if (!type.ok) return type;
      const json = await (await admin.graphql(`#graphql
        query { metaobjectDefinitionByType(type: "${TYPE}") { id } }`)).json();
      return done(await run(CREATE_LINK, {
        definition: {
          ...LINK, name: "Size guide", ownerType: "PRODUCT", type: "metaobject_reference", pin: true,
          validations: [{ name: "metaobject_definition_id", value: json.data.metaobjectDefinitionByType.id }],
        },
      }), "Size guide type created");
    }
    case "create":
      return done(await run(CREATE_ENTRY, {
        metaobject: { type: TYPE, fields: fieldsFrom(f), capabilities: status(f) },
      }), `Created ${f.title}`);
    case "update":
      return done(await run(UPDATE_ENTRY, {
        id: f.id, metaobject: { fields: fieldsFrom(f), capabilities: status(f) },
      }), `Saved ${f.title}`);
    case "delete": // products that pointed at it lose their size guide
      return done(await run(DELETE_ENTRY, { id: f.id }), "Size guide deleted");
    case "assign":
      return done(await run(ASSIGN, {
        metafields: [{ ownerId: f.productId, ...LINK, value: f.guideId }],
      }), "Size guide assigned");
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
export default function SizeGuides() {
  const { ready, guides, products } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [editing, setEditing] = useState(null); // null = a new entry
  const [formKey, setFormKey] = useState(0);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      setFormKey((k) => k + 1);
      document.getElementById("guide-modal")?.hideOverlay();
    } else {
      shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const open = (guide) => {
    setEditing(guide);
    setFormKey((k) => k + 1);
    document.getElementById("guide-modal").showOverlay();
  };
  const submit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    fetcher.submit(editing ? { ...data, intent: "update", id: editing.id } : { ...data, intent: "create" }, { method: "post" });
  };
  const assign = (e) => {
    e.preventDefault();
    fetcher.submit({ ...Object.fromEntries(new FormData(e.currentTarget)), intent: "assign" }, { method: "post" });
  };

  if (!ready) {
    return (
      <s-page heading="Size guides">
        <s-section heading="One-time setup">
          <s-paragraph>
            Creates the metaobject type "{TYPE}" (title, fit, sizes, notes) and a product field that points at one entry.
          </s-paragraph>
          <s-button variant="primary" loading={busy || undefined}
                    onClick={() => fetcher.submit({ intent: "setup" }, { method: "post" })}>Create the size guide type</s-button>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Size guides" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={() => open(null)}>Add size guide</s-button>

      {/* ENTRIES of our metaobject type */}
      <s-section heading={`Entries (type "${TYPE}")`} padding="none">
        <s-table loading={busy || undefined}>
          <s-table-header-row>
            <s-table-header listSlot="primary">Size guide</s-table-header>
            <s-table-header>Fit</s-table-header>
            <s-table-header>Sizes</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Products</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {guides.map((g) => (
              <s-table-row key={g.id}>
                <s-table-cell>
                  <s-stack gap="small-300">
                    <s-text type="strong">{g.title}</s-text>
                    <s-text color="subdued">{g.handle}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{g.fit}</s-table-cell>
                <s-table-cell>{g.sizes.join(" · ")}</s-table-cell>
                <s-table-cell><s-badge tone={g.active ? "success" : undefined}>{g.active ? "Active" : "Draft"}</s-badge></s-table-cell>
                <s-table-cell>{g.usedBy}</s-table-cell>
                <s-table-cell>
                  <s-button-group>
                    <s-button slot="secondary-actions" onClick={() => open(g)}>Edit</s-button>
                    <s-button slot="secondary-actions" tone="critical"
                              onClick={() => fetcher.submit({ intent: "delete", id: g.id }, { method: "post" })}>Delete</s-button>
                  </s-button-group>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* PRODUCTS point at one entry (metafield specs.size_guide) */}
      <s-section heading="Products">
        <s-stack gap="base">
        <form onSubmit={assign}>
          <s-grid gridTemplateColumns="1fr 1fr auto" gap="base" alignItems="end">
            <s-select name="productId" label="Product">
              {products.map((p) => <s-option key={p.id} value={p.id}>{p.title}</s-option>)}
            </s-select>
            <s-select name="guideId" label="Size guide">
              {guides.map((g) => <s-option key={g.id} value={g.id}>{g.title}</s-option>)}
            </s-select>
            <s-button type="submit" variant="primary" loading={busy || undefined}>Assign</s-button>
          </s-grid>
        </form>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Size guide</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {products.map((p) => (
              <s-table-row key={p.id}>
                <s-table-cell>{p.title}</s-table-cell>
                <s-table-cell>{p.guide ? <s-badge tone="info">{p.guide.displayName}</s-badge> : <s-text color="subdued">—</s-text>}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        </s-stack>
      </s-section>

      {/* CREATE or EDIT an entry */}
      <s-modal id="guide-modal" heading={editing ? `Edit ${editing.title}` : "Add size guide"}>
        <form id="guide-form" key={formKey} onSubmit={submit}>
          <s-stack gap="base">
            <s-text-field name="title" label="Title" required value={editing?.title || ""} />
            <s-select name="fit" label="Fit" value={editing?.fit || "Regular"}>
              {FITS.map((f) => <s-option key={f} value={f}>{f}</s-option>)}
            </s-select>
            <s-text-field name="sizes" label="Sizes" details="Separate sizes with commas" value={editing?.sizes.join(", ") || ""} />
            <s-text-area name="notes" label="Notes" rows={3} value={editing?.notes || ""} />
            <s-checkbox name="active" label="Active (visible on the storefront)" checked={editing?.active || undefined} />
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("guide-form").requestSubmit()}>
          {editing ? "Save" : "Add size guide"}
        </s-button>
        <s-button slot="secondary-actions" commandFor="guide-modal" command="--hide">Cancel</s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
