import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Episode 17: themes. Scope read_themes (write_themes for edits — and edits ALSO need an exemption from Shopify).
// themes → theme files (filename patterns) → file body → "does this theme support app blocks?"

// ─── READ ────────────────────────────────────────────────────────────────────
const THEMES = `#graphql
  query Themes {
    themes(first: 20) { nodes { id name role updatedAt } }
  }`;
const FILES = `#graphql
  query ThemeFiles($id: ID!, $patterns: [String!]) {
    theme(id: $id) {
      files(first: 50, filenames: $patterns) { nodes { filename size updatedAt } }
    }
  }`;
const BODY = `... on OnlineStoreThemeFileBodyText { content }`;
const FILE = `#graphql
  query ThemeFile($id: ID!, $name: String!) {
    theme(id: $id) { files(first: 1, filenames: [$name]) { nodes { filename size body { ${BODY} } } } }
  }`;

// One request for ALL themes: GraphQL aliases t0, t1, … each read one file of one theme
const readEach = (themes, filenameOf) => `#graphql
  query Each {
    ${themes.map((t, i) => `t${i}: theme(id: "${t.id}") { files(first: 1, filenames: ["${filenameOf(t)}"]) { nodes { body { ${BODY} } } } }`).join("\n")}
  }`;
const content = (data, i) => data[`t${i}`]?.files.nodes[0]?.body?.content ?? "";
// Shopify puts a /* comment */ on top of JSON templates — strip it before JSON.parse
const parseJson = (text) => JSON.parse(text.replace(/^\/\*[\s\S]*?\*\/\s*/, "") || "{}");

// App blocks = the product template's main section accepts blocks of type "@app" in its {% schema %}
const schemaOf = (liquid) => liquid.match(/{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema/)?.[1] ?? "";
// Which block types a section accepts, read from its {% schema %}: "@app" = app blocks, "@theme" = theme blocks
const blockTypes = (liquid) => { try { return (JSON.parse(schemaOf(liquid) || "{}").blocks ?? []).map((b) => b.type); } catch { return []; } };

async function appBlockSupport(gql, themes) {
  const templates = await gql(readEach(themes, () => "templates/product.json"));
  const mainType = themes.map((t, i) => {
    const sections = parseJson(content(templates, i)).sections ?? {};
    return (sections.main ?? Object.values(sections)[0])?.type;
  });
  const sections = await gql(readEach(themes, (t) => `sections/${mainType[themes.indexOf(t)]}.liquid`));
  return themes.map((t, i) => ({ section: mainType[i], appBlocks: blockTypes(content(sections, i)).includes("@app") }));
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const url = new URL(request.url);

  const themes = (await gql(THEMES)).themes.nodes;
  const support = await appBlockSupport(gql, themes);
  const list = themes.map((t, i) => ({ ...t, ...support[i], number: t.id.split("/").pop() }));

  const selected = list.find((t) => t.id === url.searchParams.get("theme")) ?? list.find((t) => t.role === "MAIN");
  const pattern = url.searchParams.get("pattern") || "templates/*.json";
  const files = (await gql(FILES, { id: selected.id, patterns: [pattern] })).theme.files.nodes;
  const name = url.searchParams.get("file");
  const file = name ? (await gql(FILE, { id: selected.id, name })).theme.files.nodes[0] : null;

  const isSection = file && /^sections\/.*\.liquid$/.test(file.filename);
  return { themes: list, selected, pattern, files, file, blocks: isSection ? blockTypes(file.body?.content ?? "") : null };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
const UPSERT = `#graphql
  mutation SaveFile($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { field message }
    }
  }`;

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  try {
    const r = (await (await admin.graphql(UPSERT, { variables: {
      themeId: f.themeId,
      files: [{ filename: f.filename, body: { type: "TEXT", value: f.value } }],
    } })).json()).data.themeFilesUpsert;
    return r.userErrors.length ? { ok: false, errors: r.userErrors } : { ok: true, message: `Saved ${f.filename}` };
  } catch (error) {
    // Access errors are not userErrors: GraphQL answers with top-level "errors" and the client throws
    const errors = error.body?.errors?.graphQLErrors ?? [{ message: error.message }];
    return { ok: false, denied: true, errors: errors.map((e) => ({ message: e.message, code: e.extensions?.code })) };
  }
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
export default function Themes() {
  const { themes, selected, pattern, files, file, blocks } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [, setSearch] = useSearchParams();
  const [filter, setFilter] = useState(pattern);
  const param = (values) => setSearch((p) => { Object.entries(values).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k))); return p; });

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show(fetcher.data.message);
    else if (!fetcher.data.denied) shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  const denied = fetcher.data?.denied ? fetcher.data.errors[0] : null;

  return (
    <s-page heading="Themes" inlineSize="large">
      {/* THEMES */}
      <s-section heading={`Themes (${themes.length})`}>
        <s-table>
          <s-table-header-row>
            <s-table-header>Theme</s-table-header>
            <s-table-header>Role</s-table-header>
            <s-table-header>Product section</s-table-header>
            <s-table-header>App blocks</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {themes.map((t) => (
              <s-table-row key={t.id}>
                <s-table-cell><s-text type={t.id === selected.id ? "strong" : undefined}>{t.name}</s-text></s-table-cell>
                <s-table-cell>{t.role === "MAIN" ? <s-badge tone="success">Live</s-badge> : <s-badge>{t.role.toLowerCase()}</s-badge>}</s-table-cell>
                <s-table-cell><s-text color="subdued">{t.section}</s-text></s-table-cell>
                <s-table-cell>{t.appBlocks ? <s-badge tone="success">Supported</s-badge> : <s-badge tone="critical">Not supported</s-badge>}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small">
                    <s-button accessibilityLabel={`Browse files of ${t.name}`} onClick={() => param({ theme: t.id, file: "" })}>Browse files</s-button>
                    <s-button variant="tertiary" href={`shopify://admin/themes/${t.number}/editor`} target="_blank">Theme editor</s-button>
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* FILES OF THE SELECTED THEME */}
      <s-section heading={`Files · ${selected.name}${selected.role === "MAIN" ? " (live)" : ""}`}>
        <s-stack gap="base">
          <form onSubmit={(e) => { e.preventDefault(); param({ pattern: filter, file: "" }); }}>
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
              <s-text-field label="Filename pattern" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} details="Wildcards work: sections/*.liquid, snippets/*, config/settings_data.json" />
              <s-button type="submit">Show files</s-button>
            </s-grid>
          </form>
          <s-text color="subdued">{files.length} file(s)</s-text>
          <s-stack direction="inline" gap="small">
            {files.map((f) => (
              <s-button key={f.filename} accessibilityLabel={f.filename} variant={file?.filename === f.filename ? "primary" : "secondary"} onClick={() => param({ file: f.filename })}>
                {f.filename} · {(Number(f.size) / 1024).toFixed(1)} KB
              </s-button>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      {/* ONE FILE: read it, try to save it */}
      {file && (
        <s-section heading={file.filename}>
          <form onSubmit={(e) => { e.preventDefault(); fetcher.submit({ themeId: selected.id, ...Object.fromEntries(new FormData(e.currentTarget)) }, { method: "post" }); }}>
            <s-stack gap="base">
              <input type="hidden" name="filename" value={file.filename} />
              {blocks && (blocks.includes("@app")
                ? <s-banner tone="success" heading="This section accepts app blocks">Block types in its schema: {blocks.join(", ")}</s-banner>
                : <s-banner tone="warning" heading="No app blocks in this section">Its schema lists {blocks.length ? blocks.join(", ") : "no block types at all"} — a merchant can't add your app block here.</s-banner>)}
              <s-text-area key={file.filename} name="value" label="File content" rows={14} value={file.body?.content ?? "(binary file)"} />
              {denied && (
                <s-banner tone="critical" heading={`${denied.code ?? "Error"}: Shopify did not save the file`}>
                  <s-paragraph>{denied.message.split("If you think")[0].trim()}</s-paragraph>
                </s-banner>
              )}
              <s-stack direction="inline" gap="base">
                <s-button type="submit" variant="primary" loading={fetcher.state !== "idle" || undefined}>Save file</s-button>
              </s-stack>
            </s-stack>
          </form>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
