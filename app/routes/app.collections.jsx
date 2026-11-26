import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ConditionFields, toCondition, useChange } from "../components/conditions";

// ─── READ ────────────────────────────────────────────────────────────────────
// API 2026-10: a collection gets its products from "sources".
// A source has inclusion CONDITIONS (smart) and/or hand-picked SELECTIONS (manual).
const COLLECTIONS_QUERY = `#graphql
  query Collections {
    collections(first: 25, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        descriptionHtml
        productsCount { count }
        image { url altText }
        sources {
          id
          ... on CollectionConditionsSource {
            inclusion { matchType conditions { id } }
          }
        }
      }
    }
    shop { currencyCode }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const { data } = await (await admin.graphql(COLLECTIONS_QUERY)).json();
  return { collections: data.collections.nodes, currency: data.shop.currencyCode };
};

// ─── CREATE / UPDATE / DELETE ────────────────────────────────────────────────
const CREATE = `#graphql
  mutation CreateCollection($collection: CollectionCreateInput!) {
    collectionCreate(collection: $collection) {
      collection { id title }
      userErrors { field message }
    }
  }`;
const UPDATE = `#graphql
  mutation UpdateCollection($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection { id title }
      userErrors { field message }
    }
  }`;
const DELETE = `#graphql
  mutation DeleteCollection($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors { field message }
    }
  }`;

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = Object.fromEntries(await request.formData());
  const run = async (query, variables) =>
    Object.values((await (await admin.graphql(query, { variables })).json()).data)[0];
  const done = (result, message) =>
    result.userErrors.length ? { ok: false, errors: result.userErrors } : { ok: true, message };
  const descriptionHtml = form.description ? `<p>${form.description}</p>` : "";

  if (form.intent === "create") {
    // smart = a source with a condition; manual = no source yet (an empty source is rejected),
    // the collection page adds one with the first products you pick
    const collection = { title: form.title, descriptionHtml };
    if (form.kind === "smart") {
      collection.sources = [{
        source: { title: "Rules", inclusion: { matchType: "ALL", conditions: [toCondition(form, form.currency)] } },
      }];
    }
    const result = await run(CREATE, { collection });
    return done(result, `Created “${result.collection?.title}”`);
  }

  if (form.intent === "update") {
    const result = await run(UPDATE, { collection: { id: form.id, title: form.title, descriptionHtml } });
    return done(result, `Saved “${result.collection?.title}”`);
  }

  if (form.intent === "delete") {
    return done(await run(DELETE, { input: { id: form.id } }), "Collection deleted");
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const stripHtml = (html) => (html || "").replace(/<[^>]+>/g, "");
const isSmart = (c) => c.sources.some((s) => s.inclusion?.conditions?.length);

export default function Collections() {
  const { collections, currency } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [editing, setEditing] = useState(null); // null = new collection
  const [deleting, setDeleting] = useState(null);
  const [kind, setKind] = useState("manual");
  const [formKey, setFormKey] = useState(0);
  const busy = fetcher.state !== "idle";
  const kindRef = useChange((e) => setKind(e.currentTarget.values[0]));

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      setFormKey((k) => k + 1);
      // Shopify matches products to conditions in the background: load once more a moment later
      setTimeout(() => revalidator.revalidate(), 3000);
      ["collection-modal", "delete-modal"].forEach((id) => document.getElementById(id)?.hideOverlay());
    } else {
      shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]); // eslint-disable-line react-hooks/exhaustive-deps

  const openForm = (collection) => {
    setEditing(collection);
    setKind("manual");
    setFormKey((k) => k + 1);
    document.getElementById("collection-modal").showOverlay();
  };
  const submit = (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    data.set("intent", editing ? "update" : "create");
    data.set("currency", currency);
    if (editing) data.set("id", editing.id);
    fetcher.submit(data, { method: "post" });
  };

  return (
    <s-page heading="Collections" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={() => openForm(null)}>
        Create collection
      </s-button>

      <s-section padding="none">
        <s-table loading={busy || undefined}>
          <s-table-header-row>
            <s-table-header listSlot="primary">Collection</s-table-header>
            <s-table-header>Type</s-table-header>
            <s-table-header format="numeric">Products</s-table-header>
            <s-table-header>Handle</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {collections.map((c) => (
              <s-table-row key={c.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-thumbnail size="small" alt={c.title} src={c.image?.url || undefined} />
                    <s-link href={`/app/collections/${c.id.split("/").pop()}`}>{c.title}</s-link>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  {isSmart(c) ? <s-badge tone="info">Smart</s-badge> : <s-badge>Manual</s-badge>}
                </s-table-cell>
                <s-table-cell>{c.productsCount.count}</s-table-cell>
                <s-table-cell>{c.handle}</s-table-cell>
                <s-table-cell>
                  <s-button-group>
                    <s-button slot="secondary-actions" onClick={() => openForm(c)}>Edit</s-button>
                    <s-button slot="secondary-actions" tone="critical" onClick={() => {
                      setDeleting(c); document.getElementById("delete-modal").showOverlay();
                    }}>Delete</s-button>
                  </s-button-group>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* CREATE (manual or smart) + UPDATE (title, description) */}
      <s-modal id="collection-modal" heading={editing ? `Edit ${editing.title}` : "Create collection"}>
        <form id="collection-form" key={formKey} onSubmit={submit}>
          <s-stack gap="base">
            <s-text-field name="title" label="Title" required value={editing?.title || ""} />
            <s-text-area name="description" label="Description" rows={2}
                         value={stripHtml(editing?.descriptionHtml)} />
            {!editing && (
              <s-choice-list ref={kindRef} name="kind" label="Collection type" values={[kind]}>
                <s-choice value="manual">Manual: you pick the products</s-choice>
                <s-choice value="smart">Smart: products that match a condition join automatically</s-choice>
              </s-choice-list>
            )}
            {!editing && kind === "smart" && <ConditionFields />}
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("collection-form").requestSubmit()}>
          {editing ? "Save" : "Create collection"}
        </s-button>
        <s-button slot="secondary-actions" commandFor="collection-modal" command="--hide">Cancel</s-button>
      </s-modal>

      {/* DELETE confirmation */}
      <s-modal id="delete-modal" heading="Delete collection?">
        <s-paragraph>“{deleting?.title}” will be deleted. Its products stay in your store.</s-paragraph>
        <s-button slot="primary-action" variant="primary" tone="critical" loading={busy || undefined}
                  onClick={() => fetcher.submit({ intent: "delete", id: deleting.id }, { method: "post" })}>
          Delete
        </s-button>
        <s-button slot="secondary-actions" commandFor="delete-modal" command="--hide">Cancel</s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
