import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { CONDITION_FIELDS, ConditionFields, describe, toCondition, useChange } from "../components/conditions";

// ─── READ ────────────────────────────────────────────────────────────────────
// The collection, its products, and its source: conditions + hand-picked + excluded products.
const COLLECTION_QUERY = `#graphql
  query Collection($id: ID!) {
    collection(id: $id) {
      id
      title
      productsCount { count }
      products(first: 50) {
        nodes { id title productType featuredMedia { preview { image { url } } }
                priceRangeV2 { minVariantPrice { amount currencyCode } } }
      }
      sources {
        id
        ... on CollectionConditionsSource {
          inclusion {
            matchType
            conditions { ${CONDITION_FIELDS} }
            selections(first: 100) { nodes { product { id } } }
          }
          exclusion { selections(first: 50) { nodes { product { id title } } } }
        }
      }
    }
    shop { currencyCode }
  }`;

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(COLLECTION_QUERY, {
    variables: { id: `gid://shopify/Collection/${params.id}` },
  });
  const { data } = await response.json();
  if (!data.collection) throw new Response("Collection not found", { status: 404 });
  return { collection: data.collection, currency: data.shop.currencyCode };
};

// ─── UPDATE THE SOURCE: add / remove / exclude products, add / delete conditions ─
// Since API 2026-10 all of this is ONE mutation: collectionUpdate → sourcesToUpdate.
// (collectionAddProducts and collectionRemoveProducts are deprecated.)
const UPDATE_SOURCE = `#graphql
  mutation UpdateSource($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection { productsCount { count } }
      userErrors { field message }
    }
  }`;

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const form = Object.fromEntries(await request.formData());
  const id = `gid://shopify/Collection/${params.id}`;
  const ids = (key) => JSON.parse(form[key] || "[]").map((productId) => ({ productId }));

  // what to change on the source (each intent builds only its own change)
  const changes = {
    add: () => ({ inclusion: { selectionsToAdd: ids("productIds") } }),
    remove: () => ({ inclusion: { selectionsToRemove: ids("productIds") } }),
    exclude: () => ({ exclusion: { selectionsToAdd: ids("productIds") } }),
    include: () => ({ exclusion: { selectionsToRemove: ids("productIds") } }),
    addCondition: () => ({ inclusion: { conditionsToCreate: [toCondition(form, form.currency)] } }),
    deleteCondition: () => ({ inclusion: { conditionsToDelete: [form.conditionId] } }),
    matchType: () => ({ inclusion: { matchType: form.matchType } }),
  };
  const change = changes[form.intent]?.();
  if (!change) return { ok: false, errors: [{ message: "Unknown action" }] };

  // a collection without a source yet (a new manual one) gets its first source:
  // create inputs use "selections" / "conditions" instead of "...ToAdd" / "...ToCreate"
  const first = {
    add: () => ({ inclusion: { selections: ids("productIds") } }),
    addCondition: () => ({ inclusion: { matchType: "ALL", conditions: [toCondition(form, form.currency)] } }),
  }[form.intent];
  const collection = form.sourceId
    ? { id, sourcesToUpdate: [{ condition: { id: form.sourceId, ...change } }] }
    : { id, sourcesToCreate: [{ source: { title: "Picked products", ...first?.() } }] };
  const response = await admin.graphql(UPDATE_SOURCE, { variables: { collection } });
  const result = (await response.json()).data.collectionUpdate;
  if (result.userErrors.length) return { ok: false, errors: result.userErrors };
  return { ok: true, message: `Saved · ${result.collection.productsCount.count} products` };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const money = (m) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: m.currencyCode }).format(m.amount);

export default function CollectionProducts() {
  const { collection, currency } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [formKey, setFormKey] = useState(0);
  const busy = fetcher.state !== "idle";
  const matchRef = useChange((e) => post("matchType", { matchType: e.currentTarget.value }));

  const source = collection.sources.find((s) => s.inclusion) || null;
  const conditions = source?.inclusion.conditions || [];
  const picked = new Set(source?.inclusion.selections.nodes.map((n) => n.product.id));
  const excluded = source?.exclusion?.selections.nodes.map((n) => n.product) || [];

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      setFormKey((k) => k + 1);
      // Shopify matches products to conditions in the background: load once more a moment later
      setTimeout(() => revalidator.revalidate(), 3000);
      document.getElementById("condition-modal")?.hideOverlay();
    } else {
      shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = (intent, data = {}) =>
    fetcher.submit({ intent, sourceId: source?.id || "", currency, ...data }, { method: "post" });

  // Shopify's own product picker (App Bridge) → the selected product IDs
  const addProducts = async () => {
    const selected = await shopify.resourcePicker({ type: "product", multiple: true, filter: { variants: false } });
    if (selected?.length) post("add", { productIds: JSON.stringify(selected.map((p) => p.id)) });
  };
  const addCondition = (e) => {
    e.preventDefault();
    post("addCondition", Object.fromEntries(new FormData(e.currentTarget)));
  };

  return (
    <s-page heading={collection.title} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/collections">Collections</s-link>
      <s-button slot="primary-action" variant="primary" loading={busy || undefined} onClick={addProducts}>
        Add products
      </s-button>

      {/* CONDITIONS: products that match join automatically (smart collection) */}
      <s-section heading="Conditions">
        <s-stack gap="base">
          {!conditions.length && <s-paragraph>No conditions: this is a manual collection. You pick every product.</s-paragraph>}
          {conditions.length > 0 && (
            <s-select ref={matchRef} label="Products must match" value={source.inclusion.matchType || "ALL"}>
              <s-option value="ALL">all conditions</s-option>
              <s-option value="ANY">any condition</s-option>
            </s-select>
          )}
          {conditions.map((c) => (
            <s-stack key={c.id} direction="inline" gap="small-200" alignItems="center">
              <s-badge tone="info">{describe(c)}</s-badge>
              <s-button variant="tertiary" tone="critical" icon="delete" accessibilityLabel={`Delete ${describe(c)}`}
                        onClick={() => post("deleteCondition", { conditionId: c.id })} />
            </s-stack>
          ))}
          <s-stack direction="inline">
            <s-button onClick={() => document.getElementById("condition-modal").showOverlay()}>Add condition</s-button>
          </s-stack>
        </s-stack>
      </s-section>

      {/* PRODUCTS: hand-picked ones can be removed; matched ones can be excluded */}
      <s-section heading={`Products (${collection.productsCount.count})`} padding="none">
        <s-table loading={busy || undefined}>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Type</s-table-header>
            <s-table-header format="currency">Price</s-table-header>
            <s-table-header>Added by</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {collection.products.nodes.map((p) => (
              <s-table-row key={p.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-thumbnail size="small" alt={p.title} src={p.featuredMedia?.preview?.image?.url || undefined} />
                    <s-text type="strong">{p.title}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{p.productType}</s-table-cell>
                <s-table-cell>{money(p.priceRangeV2.minVariantPrice)}</s-table-cell>
                <s-table-cell>
                  {picked.has(p.id) ? <s-badge>Picked</s-badge> : <s-badge tone="info">Condition</s-badge>}
                </s-table-cell>
                <s-table-cell>
                  {picked.has(p.id)
                    ? <s-button tone="critical" onClick={() => post("remove", { productIds: JSON.stringify([p.id]) })}>Remove</s-button>
                    : <s-button onClick={() => post("exclude", { productIds: JSON.stringify([p.id]) })}>Exclude</s-button>}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* EXCLUDED: match a condition but are kept out on purpose */}
      {excluded.length > 0 && (
        <s-section heading={`Excluded (${excluded.length})`}>
          <s-stack gap="small-200">
            {excluded.map((p) => (
              <s-stack key={p.id} direction="inline" gap="small-200" alignItems="center">
                <s-text>{p.title}</s-text>
                <s-button variant="tertiary" onClick={() => post("include", { productIds: JSON.stringify([p.id]) })}>
                  Include again
                </s-button>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      )}

      {/* ADD CONDITION */}
      <s-modal id="condition-modal" heading="Add condition">
        <form id="condition-form" key={formKey} onSubmit={addCondition}>
          <ConditionFields />
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("condition-form").requestSubmit()}>Add condition</s-button>
        <s-button slot="secondary-actions" commandFor="condition-modal" command="--hide">Cancel</s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
