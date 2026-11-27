import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Episode 10: files & media. Scope write_files (fileCreate / fileUpdate / fileDelete) + write_products (product media).

// ─── READ ────────────────────────────────────────────────────────────────────
const FILES_QUERY = `#graphql
  query Files {
    files(first: 6, sortKey: CREATED_AT, reverse: true, query: "media_type:IMAGE") {
      nodes {
        id alt fileStatus createdAt
        fileErrors { code message details }
        ... on MediaImage { image { url width height } }
      }
    }
    products(first: 10, sortKey: TITLE) {
      nodes { id title mediaCount { count } }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const { data } = await (await admin.graphql(FILES_QUERY)).json();
  return {
    files: data.files.nodes.map((f) => ({
      id: f.id, alt: f.alt, status: f.fileStatus, url: f.image?.url ?? null,
      size: f.image ? `${f.image.width}×${f.image.height}` : "—",
      error: f.fileErrors?.[0] ? (f.fileErrors[0].details || f.fileErrors[0].message).split(" - ")[0] : null,
    })),
    products: data.products.nodes.map((p) => ({ id: p.id, title: p.title, images: p.mediaCount.count })),
  };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
// 1. Ask Shopify for a temporary upload target (a signed URL + form fields).
const STAGE = `#graphql
  mutation Stage($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;
// 3. Turn the uploaded bytes (or any public URL) into a file in the store's Files.
const CREATE = `#graphql
  mutation CreateFile($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus }
      userErrors { field message code }
    }
  }`;
// Attach / detach: a file becomes product media by referencing the product.
const UPDATE = `#graphql
  mutation UpdateFile($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files { id alt }
      userErrors { field message code }
    }
  }`;
const DELETE = `#graphql
  mutation DeleteFile($ids: [ID!]!) {
    fileDelete(fileIds: $ids) {
      deletedFileIds
      userErrors { field message code }
    }
  }`;

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const reply = (result, message) =>
    result.userErrors.length ? { ok: false, errors: result.userErrors } : { ok: true, message };

  switch (intent) {
    case "upload": {
      const file = form.get("file");
      if (!file || !file.size) return { ok: false, errors: [{ message: "Choose an image first" }] };
      // 1. staged target
      const staged = (await gql(STAGE, { input: [{
        filename: file.name, mimeType: file.type, httpMethod: "POST", resource: "IMAGE", fileSize: String(file.size),
      }] })).stagedUploadsCreate;
      if (staged.userErrors.length) return { ok: false, errors: staged.userErrors };
      const target = staged.stagedTargets[0];
      // 2. POST the bytes straight to that URL: every parameter first, the file last
      const body = new FormData();
      for (const { name, value } of target.parameters) body.append(name, value);
      body.append("file", file, file.name);
      const upload = await fetch(target.url, { method: "POST", body });
      if (!upload.ok) return { ok: false, errors: [{ message: `Upload failed: ${upload.status}` }] };
      // 3. fileCreate with the resourceUrl
      const created = (await gql(CREATE, { files: [{
        originalSource: target.resourceUrl, contentType: "IMAGE", alt: form.get("alt") || file.name,
      }] })).fileCreate;
      return reply(created, "Uploaded: processing");
    }
    case "url": {
      const created = (await gql(CREATE, { files: [{
        originalSource: form.get("url"), contentType: "IMAGE", alt: form.get("alt") || "",
      }] })).fileCreate;
      return reply(created, "Added from URL: processing");
    }
    case "attach":
      return reply((await gql(UPDATE, { files: [{ id: form.get("id"), referencesToAdd: [form.get("productId")] }] })).fileUpdate,
        "Added to the product");
    case "detach":
      return reply((await gql(UPDATE, { files: [{ id: form.get("id"), referencesToRemove: [form.get("productId")] }] })).fileUpdate,
        "Removed from the product");
    case "delete":
      return reply((await gql(DELETE, { ids: [form.get("id")] })).fileDelete, "File deleted");
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const TONE = { READY: "success", FAILED: "critical", UPLOADED: "info", PROCESSING: "info" };

export default function Files() {
  const { files, products } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const busy = fetcher.state !== "idle";
  const picker = useRef(null);
  const [picked, setPicked] = useState(null);
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const selected = products.find((p) => p.id === productId);

  // fileCreate returns at once with status UPLOADED; Shopify processes the image in the background → re-read until READY/FAILED
  const waiting = files.some((f) => f.status === "UPLOADED" || f.status === "PROCESSING");
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => revalidator.state === "idle" && revalidator.revalidate(), 1500);
    return () => clearInterval(t);
  }, [waiting, revalidator]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show(fetcher.data.message);
    else shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  const upload = (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    data.set("intent", "upload");
    if (picked) data.set("file", picked);
    fetcher.submit(data, { method: "post", encType: "multipart/form-data" });
  };
  const fromUrl = (e) => {
    e.preventDefault();
    fetcher.submit({ ...Object.fromEntries(new FormData(e.currentTarget)), intent: "url" }, { method: "post" });
  };
  const send = (intent, id) => fetcher.submit({ intent, id, productId }, { method: "post" });

  return (
    <s-page heading="Files & media" inlineSize="large">
      <s-section heading="Add an image">
        <s-grid gridTemplateColumns="1fr 1fr" gap="large">
          {/* From the computer: staged upload → fileCreate */}
          <form onSubmit={upload}>
            <s-stack gap="base">
              <s-heading>Upload from your computer</s-heading>
              <input ref={picker} type="file" accept="image/*" hidden onChange={(e) => setPicked(e.target.files[0] ?? null)} />
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button onClick={() => picker.current.click()}>Choose image</s-button>
                <s-text color="subdued">{picked ? `${picked.name} · ${Math.round(picked.size / 1024)} KB` : "No file chosen"}</s-text>
              </s-stack>
              <s-text-field name="alt" label="Alt text" placeholder="Describe the image" />
              <s-button type="submit" variant="primary" loading={busy || undefined}>Upload</s-button>
            </s-stack>
          </form>
          {/* From a public URL: fileCreate downloads it */}
          <form onSubmit={fromUrl}>
            <s-stack gap="base">
              <s-heading>Add from a URL</s-heading>
              <s-text-field name="url" label="Image URL" placeholder="https://…" />
              <s-text-field name="alt" label="Alt text" placeholder="Describe the image" />
              <s-button type="submit" loading={busy || undefined}>Add from URL</s-button>
            </s-stack>
          </form>
        </s-grid>
      </s-section>

      <s-section heading="Latest images" padding="none">
        <s-box padding="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
            <s-select label="Product for Add / Remove" value={productId} onChange={(e) => setProductId(e.currentTarget.value)}>
              {products.map((p) => <s-option key={p.id} value={p.id}>{p.title}</s-option>)}
            </s-select>
            <s-badge tone="info">{selected ? `${selected.images} ${selected.images === 1 ? "image" : "images"}` : "—"}</s-badge>
          </s-grid>
        </s-box>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Image</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Size</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {files.map((f) => (
              <s-table-row key={f.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-thumbnail size="small" alt={f.alt} src={f.url || undefined} />
                    <s-text>{f.alt || "(no alt text)"}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={TONE[f.status]}>{f.status.toLowerCase()}</s-badge>
                  {f.error && <s-text color="subdued"> {f.error}</s-text>}
                </s-table-cell>
                <s-table-cell>{f.size}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200">
                    <s-button disabled={f.status !== "READY" || undefined} onClick={() => send("attach", f.id)}>Add to product</s-button>
                    <s-button disabled={f.status !== "READY" || undefined} onClick={() => send("detach", f.id)}>Remove</s-button>
                    <s-button tone="critical" onClick={() => send("delete", f.id)}>Delete</s-button>
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Products" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Images</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {products.map((p) => (
              <s-table-row key={p.id}>
                <s-table-cell>{p.title}</s-table-cell>
                <s-table-cell>{p.images}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
