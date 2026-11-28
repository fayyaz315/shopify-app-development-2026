import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Episode 18: our theme app extension (extensions/store-helper-blocks) on the storefront.
// The app never edits theme files (that needs an exemption, see Episode 17). Instead:
//   app block  "product_badge"    → the merchant adds it to the product page
//   app embed  "announcement_bar" → the merchant switches it on under App embeds
// This page checks every theme for both, and deep-links into the theme editor to add them.
const BLOCK = "product_badge";
const EMBED = "announcement_bar";

const THEMES = `#graphql
  query Themes {
    themes(first: 20) { nodes { id name role } }
  }`;
const BODY = `... on OnlineStoreThemeFileBodyText { content }`;
// Two files per theme, all themes in ONE request (aliases t0, t1, …)
const readEach = (themes) => `#graphql
  query Each {
    ${themes.map((t, i) => `t${i}: theme(id: "${t.id}") {
      files(first: 2, filenames: ["templates/product.json", "config/settings_data.json"]) { nodes { filename body { ${BODY} } } }
    }`).join("\n")}
  }`;
// Shopify puts a /* comment */ on top of these JSON files — strip it before JSON.parse
const parseJson = (text = "") => { try { return JSON.parse(text.replace(/^\/\*[\s\S]*?\*\/\s*/, "") || "{}"); } catch { return {}; } };
// Our blocks show up as type "shopify://apps/<app>/blocks/<handle>/<uid>"
const isOurs = (type = "", handle) => type.startsWith("shopify://apps/") && type.includes(`/blocks/${handle}/`);

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const gql = async (query) => (await (await admin.graphql(query)).json()).data;

  const themes = (await gql(THEMES)).themes.nodes;
  const files = await gql(readEach(themes));
  const store = session.shop.replace(".myshopify.com", "");
  const apiKey = process.env.SHOPIFY_API_KEY;

  return {
    themes: themes.map((t, i) => {
      const file = (name) => files[`t${i}`].files.nodes.find((f) => f.filename === name)?.body?.content;
      // App block: any section of the product template holding a block of our type
      const product = parseJson(file("templates/product.json"));
      const badge = Object.values(product.sections ?? {}).some((s) => Object.values(s.blocks ?? {}).some((b) => isOurs(b.type, BLOCK)));
      // App embed: theme settings → current → blocks, switched on when "disabled" isn't true
      const settings = parseJson(file("config/settings_data.json"));
      const embed = Object.values(settings.current?.blocks ?? {}).find((b) => isOurs(b.type, EMBED));
      const number = t.id.split("/").pop();
      const editor = `https://admin.shopify.com/store/${store}/themes/${number}/editor`;
      return {
        ...t, badge, embed: embed ? (embed.disabled ? "off" : "on") : "missing",
        // Deep links: Shopify opens the theme editor with our block added / our embed switched on (the merchant still clicks Save)
        addBadge: `${editor}?template=product&addAppBlockId=${apiKey}/${BLOCK}&target=mainSection`,
        addEmbed: `${editor}?context=apps&template=index&activateAppId=${apiKey}/${EMBED}`,
      };
    }),
  };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
export default function Storefront() {
  const { themes } = useLoaderData();
  const go = (url) => () => window.open(url, "_top");

  return (
    <s-page heading="Storefront" inlineSize="large">
      <s-section heading="Our theme app extension">
        <s-paragraph>
          Two blocks from <s-text type="strong">store-helper-blocks</s-text>: a <s-text type="strong">Product badge</s-text> (app block, product page)
          and an <s-text type="strong">Announcement bar</s-text> (app embed, every page).
        </s-paragraph>
      </s-section>

      <s-section heading={`Themes (${themes.length})`}>
        <s-table>
          <s-table-header-row>
            <s-table-header>Theme</s-table-header>
            <s-table-header>Role</s-table-header>
            <s-table-header>Product badge</s-table-header>
            <s-table-header>Announcement bar</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {themes.map((t) => (
              <s-table-row key={t.id}>
                <s-table-cell>{t.name}</s-table-cell>
                <s-table-cell>{t.role === "MAIN" ? <s-badge tone="success">Live</s-badge> : <s-badge>{t.role.toLowerCase()}</s-badge>}</s-table-cell>
                <s-table-cell>{t.badge ? <s-badge tone="success">Added</s-badge> : <s-badge>Not added</s-badge>}</s-table-cell>
                <s-table-cell>
                  {t.embed === "on" ? <s-badge tone="success">On</s-badge> : t.embed === "off" ? <s-badge tone="warning">Off</s-badge> : <s-badge>Not added</s-badge>}
                </s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small">
                    <s-button accessibilityLabel={`Add badge to ${t.name} ${t.id}`} onClick={go(t.addBadge)}>Add badge</s-button>
                    <s-button accessibilityLabel={`Turn on bar for ${t.name} ${t.id}`} onClick={go(t.addEmbed)}>Turn on bar</s-button>
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
