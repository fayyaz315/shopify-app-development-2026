import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Episode 12: languages, translations and markets. Scopes write_locales, write_translations, write_markets.
const OFFER = ["de", "fr", "es", "it", "nl", "ar", "ur"]; // languages the "Add language" picker offers

// ─── READ ────────────────────────────────────────────────────────────────────
const QUERY = `#graphql
  query Languages {
    shopLocales { locale name primary published }
    pages(first: 10, sortKey: UPDATED_AT, reverse: true) { nodes { id title handle } }
    webPresences(first: 5) {
      nodes { id subfolderSuffix alternateLocales { locale } rootUrls { locale url } }
    }
    markets(first: 10) {
      nodes {
        id name handle status
        conditions { regionsCondition { regions(first: 50) { nodes { name } } } }
        currencySettings { baseCurrency { currencyCode } }
        webPresences(first: 1) { nodes { subfolderSuffix defaultLocale { locale } alternateLocales { locale } } }
      }
    }
  }`;
// Every translatable field comes with a digest: a fingerprint of the English text you are translating
const RESOURCE = `#graphql
  query Resource($id: ID!, $locale: String!) {
    translatableResource(resourceId: $id) {
      translatableContent { key value digest }
      translations(locale: $locale) { key value outdated }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const data = await gql(QUERY);
  const locales = data.shopLocales;
  const others = locales.filter((l) => !l.primary);
  const pageId = url.searchParams.get("pg") || data.pages.nodes[0]?.id || "";
  // "lang", not "locale": Shopify already adds ?locale=en (the admin language) to every embedded app URL
  const wanted = url.searchParams.get("lang");
  const locale = others.some((l) => l.locale === wanted) ? wanted : others[0]?.locale || "";
  let fields = [];
  if (pageId && locale) {
    const r = (await gql(RESOURCE, { id: pageId, locale })).translatableResource;
    fields = r.translatableContent.filter((c) => ["title", "body_html"].includes(c.key)).map((c) => {
      const t = r.translations.find((x) => x.key === c.key);
      return { ...c, translation: t?.value ?? "", outdated: t?.outdated ?? false };
    });
  }
  return {
    shop: session.shop, pages: data.pages.nodes, pageId, locale, fields,
    // where each language lives on the storefront (the main web presence = no subfolder)
    locales: locales.map((l) => ({ ...l, url: data.webPresences.nodes.find((w) => !w.subfolderSuffix)?.rootUrls.find((r) => r.locale === l.locale)?.url ?? null })),
    markets: data.markets.nodes.map((m) => ({
      id: m.id, name: m.name, status: m.status,
      regions: m.conditions?.regionsCondition?.regions.nodes.length ?? 0,
      currency: m.currencySettings?.baseCurrency.currencyCode ?? "store currency",
      path: m.webPresences.nodes[0]?.subfolderSuffix ? `/${m.webPresences.nodes[0].subfolderSuffix}` : "—",
    })),
  };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
const ENABLE = `#graphql
  mutation Enable($locale: String!) {
    shopLocaleEnable(locale: $locale) { shopLocale { locale published } userErrors { field message } }
  }`;
const UPDATE = `#graphql
  mutation Publish($locale: String!, $shopLocale: ShopLocaleInput!) {
    shopLocaleUpdate(locale: $locale, shopLocale: $shopLocale) { shopLocale { locale published } userErrors { field message } }
  }`;
// A published language still needs a web presence (a URL like /de/) before shoppers can see it
const PRESENCES = `#graphql
  query Presences { webPresences(first: 5) { nodes { id subfolderSuffix alternateLocales { locale } } } }`;
const PRESENCE_UPDATE = `#graphql
  mutation Presence($id: ID!, $input: WebPresenceUpdateInput!) {
    webPresenceUpdate(id: $id, input: $input) { webPresence { id alternateLocales { locale } } userErrors { field message code } }
  }`;
const DISABLE = `#graphql
  mutation Disable($locale: String!) {
    shopLocaleDisable(locale: $locale) { locale userErrors { field message } }
  }`;
const REGISTER = `#graphql
  mutation Translate($id: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $id, translations: $translations) {
      translations { key value }
      userErrors { field message code }
    }
  }`;

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const reply = (result, message) =>
    result.userErrors.length ? { ok: false, errors: result.userErrors } : { ok: true, message };

  switch (f.intent) {
    case "enable":
      return reply((await gql(ENABLE, { locale: f.locale })).shopLocaleEnable, `Language added: ${f.locale}`);
    case "publish": {
      const on = f.value === "true";
      const published = (await gql(UPDATE, { locale: f.locale, shopLocale: { published: on } })).shopLocaleUpdate;
      if (published.userErrors.length) return reply(published);
      // add / remove the language on the main web presence → https://store/de/
      const main = (await gql(PRESENCES)).webPresences.nodes.find((w) => !w.subfolderSuffix);
      const others = main.alternateLocales.map((l) => l.locale).filter((l) => l !== f.locale);
      return reply((await gql(PRESENCE_UPDATE, { id: main.id, input: { alternateLocales: on ? [...others, f.locale] : others } })).webPresenceUpdate,
        on ? `Published: ${f.locale}` : `Unpublished: ${f.locale}`);
    }
    case "disable":
      return reply((await gql(DISABLE, { locale: f.locale })).shopLocaleDisable, `Language removed: ${f.locale}`);
    case "translate": {
      // One TranslationInput per field: locale, key, the translated value, and the digest of the English text
      const translations = ["title", "body_html"].filter((key) => f[key]).map((key) => ({
        locale: f.locale, key, value: key === "body_html" ? `<p>${f[key]}</p>` : f[key], translatableContentDigest: f[`${key}_digest`],
      }));
      return reply((await gql(REGISTER, { id: f.pageId, translations })).translationsRegister, "Translation saved");
    }
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export default function Languages() {
  const { shop, locales, pages, pageId, locale, fields, markets } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const offer = OFFER.filter((l) => !locales.some((x) => x.locale === l));
  const [add, setAdd] = useState(offer[0] ?? "");
  useEffect(() => { if (!offer.includes(add)) setAdd(offer[0] ?? ""); }, [offer.join(), add]);
  const others = locales.filter((l) => !l.primary);
  const page = pages.find((p) => p.id === pageId);
  const [, setSearch] = useSearchParams();

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show(fetcher.data.message);
    else shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  const send = (intent, data) => fetcher.submit({ intent, ...data }, { method: "post" });
  const translate = (e) => {
    e.preventDefault();
    fetcher.submit({ ...Object.fromEntries(new FormData(e.currentTarget)), intent: "translate", pageId, locale }, { method: "post" });
  };
  const choose = (key, value) => {
    setSearch((q) => { q.set("pg", pageId); q.set("lang", locale); q.set(key === "page" ? "pg" : "lang", value); return q; });  // loader reads ?page=&locale=
  };

  return (
    <s-page heading="Languages & markets" inlineSize="large">
      {/* LANGUAGES */}
      <s-section heading="Languages">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
            <s-select label="Add a language" value={add} onChange={(e) => setAdd(e.currentTarget.value)}>
              {offer.map((l) => <s-option key={l} value={l}>{l}</s-option>)}
            </s-select>
            <s-button variant="primary" loading={busy || undefined} onClick={() => send("enable", { locale: add })}>Add language</s-button>
          </s-grid>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Language</s-table-header>
              <s-table-header>Code</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Storefront</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {locales.map((l) => (
                <s-table-row key={l.locale}>
                  <s-table-cell>{l.name}</s-table-cell>
                  <s-table-cell>{l.locale}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={l.published ? "success" : undefined}>{l.primary ? "Default" : l.published ? "Published" : "Not published"}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{l.url ? <s-link href={l.url} target="_blank">{l.url.replace(/^https:\/\/[^/]+/, "")}</s-link> : "—"}</s-table-cell>
                  <s-table-cell>
                    {!l.primary && (
                      <s-stack direction="inline" gap="small-200">
                        <s-button onClick={() => send("publish", { locale: l.locale, value: String(!l.published) })}>{l.published ? "Unpublish" : "Publish"}</s-button>
                        <s-button tone="critical" onClick={() => send("disable", { locale: l.locale })}>Remove</s-button>
                      </s-stack>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>

      {/* TRANSLATE A PAGE */}
      <s-section heading="Translate a page">
        {others.length === 0 ? <s-paragraph>Add a language first.</s-paragraph> : (
          <s-stack gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-select label="Page" value={pageId} onChange={(e) => choose("page", e.currentTarget.value)}>
                {pages.map((p) => <s-option key={p.id} value={p.id}>{p.title}</s-option>)}
              </s-select>
              <s-select label="Into" value={locale} onChange={(e) => choose("locale", e.currentTarget.value)}>
                {others.map((l) => <s-option key={l.locale} value={l.locale}>{l.name}</s-option>)}
              </s-select>
            </s-grid>
            <form key={`${pageId}-${locale}-${fields.map((x) => x.translation).join("|")}`} onSubmit={translate}>
              <s-stack gap="base">
                {fields.map((c) => (
                  <s-grid key={c.key} gridTemplateColumns="1fr 1fr" gap="base" alignItems="end">
                    <s-text-field label={`English ${c.key === "body_html" ? "text" : "title"}`} value={c.key === "body_html" ? strip(c.value) : c.value} readOnly />
                    <s-stack gap="small-200">
                      <s-text-field name={c.key} label={`${locale} ${c.key === "body_html" ? "text" : "title"}${c.outdated ? " (outdated)" : ""}`}
                                    value={c.key === "body_html" ? strip(c.translation) : c.translation} />
                      <input type="hidden" name={`${c.key}_digest`} value={c.digest} />
                    </s-stack>
                  </s-grid>
                ))}
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-button type="submit" variant="primary" loading={busy || undefined}>Save translation</s-button>
                  {page && <s-link href={`https://${shop}/${locale}/pages/${page.handle}`} target="_blank">/{locale}/pages/{page.handle}</s-link>}
                </s-stack>
              </s-stack>
            </form>
          </s-stack>
        )}
      </s-section>

      {/* MARKETS (read only) */}
      <s-section heading="Markets" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Market</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Countries</s-table-header>
            <s-table-header>Currency</s-table-header>
            <s-table-header>URL</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {markets.map((m) => (
              <s-table-row key={m.id}>
                <s-table-cell>{m.name}</s-table-cell>
                <s-table-cell><s-badge tone={m.status === "ACTIVE" ? "success" : undefined}>{m.status.toLowerCase()}</s-badge></s-table-cell>
                <s-table-cell>{m.regions}</s-table-cell>
                <s-table-cell>{m.currency}</s-table-cell>
                <s-table-cell>{m.path}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
