import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// ─── READ ────────────────────────────────────────────────────────────────────
// One GraphQL query: 10 products per page, newest first, optional search, cursor pagination.
const PRODUCTS_QUERY = `#graphql
  query Products($first: Int, $last: Int, $after: String, $before: String, $query: String) {
    products(first: $first, last: $last, after: $after, before: $before, query: $query,
             sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        status
        vendor
        productType
        tags
        descriptionHtml
        totalInventory
        variantsCount { count }
        featuredMedia { preview { image { url altText } } }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const page = before ? { last: 10, before } : { first: 10, after };

  const response = await admin.graphql(PRODUCTS_QUERY, {
    variables: { ...page, query: q ? `title:*${q}*` : null },
  });
  const { data } = await response.json();
  return { products: data.products.nodes, pageInfo: data.products.pageInfo, q };
};

// ─── CREATE / UPDATE / DELETE ────────────────────────────────────────────────
const CREATE = `#graphql
  mutation CreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }`;
const SET_PRICE = `#graphql
  mutation SetPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }`;
const UPDATE = `#graphql
  mutation UpdateProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title status }
      userErrors { field message }
    }
  }`;
const DELETE = `#graphql
  mutation DeleteProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }`;

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = Object.fromEntries(await request.formData());
  const run = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;

  const fields = {
    title: form.title,
    descriptionHtml: form.description ? `<p>${form.description}</p>` : "",
    vendor: form.vendor,
    productType: form.productType,
    status: form.status,
    tags: (form.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
  };

  if (form.intent === "create") {
    const { productCreate } = await run(CREATE, { product: fields });
    if (productCreate.userErrors.length) return { ok: false, errors: productCreate.userErrors };
    // productCreate makes one default variant; its price is set on the variant itself.
    if (form.price) {
      const { productVariantsBulkUpdate } = await run(SET_PRICE, {
        productId: productCreate.product.id,
        variants: [{ id: productCreate.product.variants.nodes[0].id, price: form.price }],
      });
      if (productVariantsBulkUpdate.userErrors.length) return { ok: false, errors: productVariantsBulkUpdate.userErrors };
    }
    return { ok: true, message: `Created “${productCreate.product.title}”` };
  }

  if (form.intent === "update") {
    const { productUpdate } = await run(UPDATE, { product: { id: form.id, ...fields } });
    if (productUpdate.userErrors.length) return { ok: false, errors: productUpdate.userErrors };
    return { ok: true, message: `Saved “${productUpdate.product.title}”` };
  }

  if (form.intent === "delete") {
    const { productDelete } = await run(DELETE, { input: { id: form.id } });
    if (productDelete.userErrors.length) return { ok: false, errors: productDelete.userErrors };
    return { ok: true, message: "Product deleted" };
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const STATUS_TONE = { ACTIVE: "success", DRAFT: "info", ARCHIVED: "neutral" };
const money = (m) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: m.currencyCode }).format(m.amount);
const stripHtml = (html) => (html || "").replace(/<[^>]+>/g, "");

export default function Products() {
  const { products, pageInfo, q } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [editing, setEditing] = useState(null); // null = new product
  const [deleting, setDeleting] = useState(null);
  const table = useRef(null);
  const busy = fetcher.state !== "idle";

  // toast + close the modal when a mutation finishes
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      document.getElementById("product-modal")?.hideOverlay();
      document.getElementById("delete-modal")?.hideOverlay();
    } else {
      shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  // s-table pagination events (React 18 does not bind custom events, so listen directly)
  useEffect(() => {
    const el = table.current;
    if (!el) return;
    const go = (key, cursor) => () => {
      const next = new URLSearchParams(params);
      next.delete("after"); next.delete("before"); next.set(key, cursor);
      navigate(`?${next}`);
    };
    const onNext = go("after", pageInfo.endCursor);
    const onPrev = go("before", pageInfo.startCursor);
    el.addEventListener("nextpage", onNext);
    el.addEventListener("previouspage", onPrev);
    return () => { el.removeEventListener("nextpage", onNext); el.removeEventListener("previouspage", onPrev); };
  }, [pageInfo, params, navigate]);

  const openForm = (product) => {
    setEditing(product);
    document.getElementById("product-modal").showOverlay();
  };
  const submit = (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    data.set("intent", editing ? "update" : "create");
    if (editing) data.set("id", editing.id);
    fetcher.submit(data, { method: "post" });
  };
  // Enter inside <s-search-field> does not submit a form, so we listen for the key ourselves.
  const search = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = e.currentTarget.value.trim();
    navigate(value ? `?q=${encodeURIComponent(value)}` : "?");
  };

  return (
    <s-page heading="Products" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={() => openForm(null)}>
        Add product
      </s-button>

      <s-section padding="none">
        <s-table
          ref={table}
          paginate
          hasNextPage={pageInfo.hasNextPage || undefined}
          hasPreviousPage={pageInfo.hasPreviousPage || undefined}
          loading={busy || undefined}
        >
          <s-search-field slot="filters" label="Search products" labelAccessibilityVisibility="exclusive"
                          placeholder="Search by title" value={q} onKeyDown={search} />
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header format="numeric">Variants</s-table-header>
            <s-table-header format="numeric">Inventory</s-table-header>
            <s-table-header format="currency">Price</s-table-header>
            <s-table-header>Vendor</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {products.map((p) => (
              <s-table-row key={p.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-thumbnail size="small" alt={p.title}
                                 src={p.featuredMedia?.preview?.image?.url || undefined} />
                    <s-link href={`/app/products/${p.id.split("/").pop()}`}>{p.title}</s-link>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={STATUS_TONE[p.status]}>{p.status.toLowerCase()}</s-badge>
                </s-table-cell>
                <s-table-cell>{p.variantsCount.count}</s-table-cell>
                <s-table-cell>{p.totalInventory}</s-table-cell>
                <s-table-cell>{money(p.priceRangeV2.minVariantPrice)}</s-table-cell>
                <s-table-cell>{p.vendor}</s-table-cell>
                <s-table-cell>
                  <s-button-group>
                    <s-button slot="secondary-actions" onClick={() => openForm(p)}>Edit</s-button>
                    <s-button slot="secondary-actions" tone="critical" onClick={() => {
                      setDeleting(p); document.getElementById("delete-modal").showOverlay();
                    }}>Delete</s-button>
                  </s-button-group>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* CREATE + UPDATE form (same modal; key remounts it with the product's values) */}
      <s-modal id="product-modal" heading={editing ? `Edit ${editing.title}` : "Add product"}>
        <form id="product-form" key={editing?.id || "new"} onSubmit={submit}>
          <s-stack gap="base">
            <s-text-field name="title" label="Title" required value={editing?.title || ""} />
            <s-text-area name="description" label="Description" rows={3}
                         value={stripHtml(editing?.descriptionHtml)} />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-select name="status" label="Status" value={editing?.status || "DRAFT"}>
                <s-option value="ACTIVE">Active</s-option>
                <s-option value="DRAFT">Draft</s-option>
                <s-option value="ARCHIVED">Archived</s-option>
              </s-select>
              {!editing && <s-money-field name="price" label="Price" placeholder="0.00" />}
              <s-text-field name="vendor" label="Vendor" value={editing?.vendor || ""} />
              <s-text-field name="productType" label="Product type" value={editing?.productType || ""} />
            </s-grid>
            <s-text-field name="tags" label="Tags" details="Separate tags with commas"
                          value={(editing?.tags || []).join(", ")} />
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary"
                  loading={busy || undefined}
                  onClick={() => document.getElementById("product-form").requestSubmit()}>
          {editing ? "Save" : "Create product"}
        </s-button>
        <s-button slot="secondary-actions" commandFor="product-modal" command="--hide">Cancel</s-button>
      </s-modal>

      {/* DELETE confirmation */}
      <s-modal id="delete-modal" heading="Delete product?">
        <s-paragraph>“{deleting?.title}” will be deleted from your store. This can’t be undone.</s-paragraph>
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
