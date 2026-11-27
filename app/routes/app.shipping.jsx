import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Episode 13: shipping - delivery profiles, zones and rates. Scope write_shipping.
const COUNTRIES = [["PK", "Pakistan"], ["AE", "United Arab Emirates"], ["GB", "United Kingdom"], ["US", "United States"], ["SA", "Saudi Arabia"]];

// ─── READ ────────────────────────────────────────────────────────────────────
// profile → location groups (which locations ship) → zones (which countries) → method definitions (the rates)
const PROFILES = `#graphql
  query Profiles {
    shop { currencyCode }
    locations(first: 5) { nodes { id name } }
    deliveryProfiles(first: 10) {
      nodes { id name default productVariantsCount { count } activeMethodDefinitionsCount }
    }
    products(first: 30, sortKey: TITLE) { nodes { id title variants(first: 20) { nodes { id } } } }
  }`;
const PROFILE = `#graphql
  query Profile($id: ID!) {
    deliveryProfile(id: $id) {
      id name default
      profileItems(first: 10) { nodes { product { id title } } }
      profileLocationGroups {
        locationGroup { id locations(first: 5) { nodes { name } } }
        locationGroupZones(first: 10) {
          nodes {
            zone { id name countries { name code { countryCode restOfWorld } } }
            methodDefinitions(first: 10) {
              nodes {
                id name active
                rateProvider { ... on DeliveryRateDefinition { price { amount currencyCode } } }
                methodConditions { field operator conditionCriteria { ... on MoneyV2 { amount currencyCode } ... on Weight { value unit } } }
              }
            }
          }
        }
      }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const data = await gql(PROFILES);
  const profiles = data.deliveryProfiles.nodes;
  const wanted = new URL(request.url).searchParams.get("profile");
  const profileId = profiles.some((p) => p.id === wanted) ? wanted : profiles[0]?.id;
  const p = (await gql(PROFILE, { id: profileId })).deliveryProfile;
  const zones = p.profileLocationGroups.flatMap((g) => g.locationGroupZones.nodes.map((z) => ({
    groupId: g.locationGroup.id,
    id: z.zone.id, name: z.zone.name,
    countries: z.zone.countries.map((c) => c.code.restOfWorld ? "Rest of world" : c.code.countryCode),
    rates: z.methodDefinitions.nodes.map((m) => ({
      id: m.id, name: m.name, active: m.active,
      price: m.rateProvider?.price ? `${m.rateProvider.price.amount} ${m.rateProvider.price.currencyCode}` : "carrier",
      when: m.methodConditions.map((c) => `${c.field === "TOTAL_WEIGHT" ? "weight" : "order total"} ${c.operator === "GREATER_THAN_OR_EQUAL_TO" ? "≥" : "≤"} ${
        c.conditionCriteria.amount ?? c.conditionCriteria.value} ${c.conditionCriteria.currencyCode ?? c.conditionCriteria.unit?.toLowerCase() ?? ""}`).join(", "),
    })),
  })));
  return {
    currency: data.shop.currencyCode, locations: data.locations.nodes, profiles,
    products: data.products.nodes.map((x) => ({ id: x.id, title: x.title, variants: x.variants.nodes.map((v) => v.id) })),
    profile: { id: p.id, name: p.name, default: p.default, products: p.profileItems.nodes.map((n) => n.product), zones },
  };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
const CREATE = `#graphql
  mutation CreateProfile($profile: DeliveryProfileInput!) {
    deliveryProfileCreate(profile: $profile) { profile { id name } userErrors { field message } }
  }`;
const UPDATE = `#graphql
  mutation UpdateProfile($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) { profile { id } userErrors { field message } }
  }`;
const REMOVE = `#graphql
  mutation RemoveProfile($id: ID!) {
    deliveryProfileRemove(id: $id) { job { id } userErrors { field message } }
  }`;

// One rate = a method definition: a name, a price, and optional conditions
const rate = (name, amount, currencyCode, over) => ({
  name, active: true,
  rateDefinition: { price: { amount: Number(amount), currencyCode } },
  ...(over ? { priceConditionsToCreate: [{ operator: "GREATER_THAN_OR_EQUAL_TO", criteria: { amount: Number(over), currencyCode } }] } : {}),
});

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const reply = (result, message, extra = {}) =>
    result.userErrors.length ? { ok: false, errors: result.userErrors } : { ok: true, message, ...extra };
  const update = async (profile, message) => reply((await gql(UPDATE, { id: f.profileId, profile })).deliveryProfileUpdate, message);

  switch (f.intent) {
    case "create": {
      const methods = [rate(f.rateName, f.price, f.currency)];
      if (f.freeOver) methods.push(rate(`Free over ${f.freeOver}`, 0, f.currency, f.freeOver));
      const r = (await gql(CREATE, { profile: {
        name: f.name,
        variantsToAssociate: f.variants ? f.variants.split(",") : [],  // moves these variants out of the General profile
        locationGroupsToCreate: [{
          locations: [f.locationId],
          zonesToCreate: [{ name: f.zoneName, countries: [{ code: f.country, includeAllProvinces: true }], methodDefinitionsToCreate: methods }],
        }],
      } })).deliveryProfileCreate;
      return reply(r, `Profile created: ${f.name}`, { id: r.profile?.id });
    }
    case "addRate":
      return update({ locationGroupsToUpdate: [{ id: f.groupId, zonesToUpdate: [{ id: f.zoneId,
        methodDefinitionsToCreate: [rate(f.rateName, f.price, f.currency, f.freeOver)] }] }] }, `Rate added: ${f.rateName}`);
    case "deleteRate":
      return update({ methodDefinitionsToDelete: [f.rateId] }, "Rate deleted");
    case "addProduct":
      return update({ variantsToAssociate: f.variants.split(",") }, "Product moved to this profile");
    case "removeProduct":
      return update({ variantsToDissociate: f.variants.split(",") }, "Product back in the General profile");
    case "delete":
      return reply((await gql(REMOVE, { id: f.profileId })).deliveryProfileRemove, "Profile deleted");
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
export default function Shipping() {
  const { currency, locations, profiles, products, profile } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const [, setSearch] = useSearchParams();
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [country, setCountry] = useState("AE");
  const variantsOf = (id) => products.find((p) => p.id === id)?.variants.join(",") ?? "";
  const show = (id) => setSearch((q) => { q.set("profile", id); return q; });

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      if (fetcher.data.id) show(fetcher.data.id);
    } else shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  const send = (intent, data) => fetcher.submit({ intent, profileId: profile.id, currency, ...data }, { method: "post" });
  const submit = (intent, extra = {}) => (e) => {
    e.preventDefault();
    send(intent, { ...Object.fromEntries(new FormData(e.currentTarget)), ...extra });
  };

  return (
    <s-page heading="Shipping" inlineSize="large">
      {/* PROFILES */}
      <s-section heading="Shipping profiles" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Profile</s-table-header>
            <s-table-header>Products (variants)</s-table-header>
            <s-table-header>Active rates</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {profiles.map((p) => (
              <s-table-row key={p.id}>
                <s-table-cell>{p.name} {p.default && <s-badge>Default</s-badge>}</s-table-cell>
                <s-table-cell>{p.productVariantsCount.count}</s-table-cell>
                <s-table-cell>{p.activeMethodDefinitionsCount}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200">
                    <s-button onClick={() => show(p.id)} disabled={p.id === profile.id || undefined}>{p.id === profile.id ? "Showing" : "Show"}</s-button>
                    {!p.default && <s-button tone="critical" onClick={() => send("delete", { profileId: p.id })}>Delete</s-button>}
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* CREATE */}
      <s-section heading="Create a profile">
        <form onSubmit={submit("create", { variants: variantsOf(productId), country, locationId: locations[0]?.id })}>
          <s-stack gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field name="name" label="Profile name" placeholder="Heavy items" />
              <s-select label="Product" value={productId} onChange={(e) => setProductId(e.currentTarget.value)}>
                {products.map((p) => <s-option key={p.id} value={p.id}>{p.title}</s-option>)}
              </s-select>
            </s-grid>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field name="zoneName" label="Zone name" placeholder="Gulf" />
              <s-select label="Country" value={country} onChange={(e) => setCountry(e.currentTarget.value)}>
                {COUNTRIES.map(([c, n]) => <s-option key={c} value={c}>{n}</s-option>)}
              </s-select>
            </s-grid>
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
              <s-text-field name="rateName" label="Rate name" placeholder="Standard" />
              <s-number-field name="price" label={`Price (${currency})`} min="0" />
              <s-number-field name="freeOver" label={`Free over (${currency}, optional)`} min="0" />
            </s-grid>
            <s-button type="submit" variant="primary" loading={busy || undefined}>Create profile</s-button>
          </s-stack>
        </form>
      </s-section>

      {/* ONE PROFILE: zones → rates, products */}
      <s-section heading={`${profile.name}: zones and rates`}>
        <s-stack gap="large">
          {profile.zones.map((z) => (
            <s-stack key={z.id} gap="small">
              <s-heading>{z.name} <s-text color="subdued">({z.countries.slice(0, 6).join(", ")}{z.countries.length > 6 ? ` +${z.countries.length - 6}` : ""})</s-text></s-heading>
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Rate</s-table-header>
                  <s-table-header>Price</s-table-header>
                  <s-table-header>Condition</s-table-header>
                  <s-table-header></s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {z.rates.map((r) => (
                    <s-table-row key={r.id}>
                      <s-table-cell>{r.name}</s-table-cell>
                      <s-table-cell>{r.price}</s-table-cell>
                      <s-table-cell>{r.when || "—"}</s-table-cell>
                      <s-table-cell>{!profile.default && <s-button tone="critical" onClick={() => send("deleteRate", { rateId: r.id })}>Delete</s-button>}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
              {!profile.default && (
                <form onSubmit={submit("addRate", { groupId: z.groupId, zoneId: z.id })}>
                  <s-grid gridTemplateColumns="1fr 1fr 1fr auto" gap="base" alignItems="end">
                    <s-text-field name="rateName" label="Rate name" placeholder="Express" />
                    <s-number-field name="price" label={`Price (${currency})`} min="0" />
                    <s-number-field name="freeOver" label="Only when order total ≥ (optional)" min="0" />
                    <s-button type="submit" loading={busy || undefined}>Add rate</s-button>
                  </s-grid>
                </form>
              )}
            </s-stack>
          ))}
          {!profile.default && (
            <s-stack gap="small">
              <s-heading>Products in this profile</s-heading>
              {profile.products.map((p) => (
                <s-stack key={p.id} direction="inline" gap="base" alignItems="center">
                  <s-text>{p.title}</s-text>
                  <s-button onClick={() => send("removeProduct", { variants: variantsOf(p.id) })}>Remove</s-button>
                </s-stack>
              ))}
              <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
                <s-select label="Move a product here" value={productId} onChange={(e) => setProductId(e.currentTarget.value)}>
                  {products.filter((p) => !profile.products.some((x) => x.id === p.id)).map((p) => <s-option key={p.id} value={p.id}>{p.title}</s-option>)}
                </s-select>
                <s-button onClick={() => send("addProduct", { variants: variantsOf(productId) })}>Move product</s-button>
              </s-grid>
            </s-stack>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
