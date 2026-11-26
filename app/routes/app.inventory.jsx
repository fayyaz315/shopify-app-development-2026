import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useChange } from "../components/conditions";

// ─── READ ────────────────────────────────────────────────────────────────────
// Stock lives on an inventory ITEM (one per variant) at a LOCATION = an inventory level.
// A level has named quantities: available, on_hand, committed, incoming, damaged …
const LOCATIONS_QUERY = `#graphql
  query Locations {
    locations(first: 20, includeInactive: true, sortKey: ID) {
      nodes {
        id
        name
        isActive
        fulfillsOnlineOrders
        deletable
        address { city countryCode }
      }
    }
  }`;

const STOCK_QUERY = `#graphql
  query Stock($locationId: ID!) {
    productVariants(first: 12, query: "tag:youtube-demo", sortKey: ID) {
      nodes {
        id
        title
        product { title featuredMedia { preview { image { url } } } }
        inventoryItem {
          id
          sku
          tracked
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available", "on_hand", "committed"]) { name quantity }
          }
        }
      }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;

  const { locations } = await gql(LOCATIONS_QUERY);
  const active = locations.nodes.filter((l) => l.isActive);
  const wanted = new URL(request.url).searchParams.get("location");
  const location = active.find((l) => l.id.endsWith(`/${wanted}`)) || active[0];

  const { productVariants } = await gql(STOCK_QUERY, { locationId: location.id });
  const rows = productVariants.nodes.map((v) => {
    const level = v.inventoryItem.inventoryLevel; // null = not stocked at this location
    const q = Object.fromEntries((level?.quantities || []).map((x) => [x.name, x.quantity]));
    return {
      itemId: v.inventoryItem.id,
      title: v.title === "Default Title" ? v.product.title : `${v.product.title} / ${v.title}`,
      image: v.product.featuredMedia?.preview?.image?.url,
      sku: v.inventoryItem.sku,
      stocked: Boolean(level),
      available: q.available ?? 0,
      onHand: q.on_hand ?? 0,
      committed: q.committed ?? 0,
    };
  });
  return { locations: locations.nodes, location, rows };
};

// ─── WRITE: inventory ────────────────────────────────────────────────────────
// API 2026-10: inventory (and location) mutations need @idempotent(key: a new key per request)
// and changeFromQuantity (the quantity you saw; if it changed since, Shopify refuses the change).
const ADJUST = `#graphql
  mutation Adjust($input: InventoryAdjustQuantitiesInput!, $key: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { reason changes { name delta quantityAfterChange } }
      userErrors { field message code }
    }
  }`;
const SET = `#graphql
  mutation SetQty($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { reason changes { name delta quantityAfterChange } }
      userErrors { field message code }
    }
  }`;
const LEVEL = `#graphql
  query Level($itemId: ID!, $locationId: ID!) {
    inventoryItem(id: $itemId) {
      inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { quantity } }
    }
  }`;
const ACTIVATE = `#graphql
  mutation Activate($inventoryItemId: ID!, $locationId: ID!, $available: Int, $key: String!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available)
      @idempotent(key: $key) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }`;

// ─── WRITE: locations ────────────────────────────────────────────────────────
const LOCATION_ADD = `#graphql
  mutation AddLocation($input: LocationAddInput!) {
    locationAdd(input: $input) { location { id name } userErrors { field message } }
  }`;
const LOCATION_EDIT = `#graphql
  mutation EditLocation($id: ID!, $input: LocationEditInput!) {
    locationEdit(id: $id, input: $input) { location { id name } userErrors { field message } }
  }`;
const LOCATION_DEACTIVATE = `#graphql
  mutation Deactivate($locationId: ID!, $destinationLocationId: ID, $key: String!) {
    locationDeactivate(locationId: $locationId, destinationLocationId: $destinationLocationId)
      @idempotent(key: $key) { location { id } locationDeactivateUserErrors { message } }
  }`;
const LOCATION_ACTIVATE = `#graphql
  mutation ActivateLocation($locationId: ID!, $key: String!) {
    locationActivate(locationId: $locationId) @idempotent(key: $key) { location { id } locationActivateUserErrors { message } }
  }`;
const LOCATION_DELETE = `#graphql
  mutation Delete($locationId: ID!) {
    locationDelete(locationId: $locationId) { deletedLocationId locationDeleteUserErrors { message } }
  }`;

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const run = async (query, variables) =>
    Object.values((await (await admin.graphql(query, { variables })).json()).data)[0];
  const done = (result, message) => {
    const errors = result.userErrors || result.locationDeactivateUserErrors ||
      result.locationActivateUserErrors || result.locationDeleteUserErrors || [];
    return errors.length ? { ok: false, errors } : { ok: true, message };
  };
  const key = crypto.randomUUID();
  const ref = "gid://my-store-helper/StockChange/" + key;

  switch (f.intent) {
    case "adjust": // +/- a number of units
      return done(await run(ADJUST, { key, input: {
        name: "available", reason: f.reason, referenceDocumentUri: ref,
        changes: [{ inventoryItemId: f.itemId, locationId: f.locationId,
                    delta: Number(f.delta), changeFromQuantity: Number(f.current) }],
      } }), `Adjusted by ${f.delta}`);

    case "set": // the counted number
      return done(await run(SET, { key, input: {
        name: "available", reason: "correction", referenceDocumentUri: ref,
        quantities: [{ inventoryItemId: f.itemId, locationId: f.locationId,
                       quantity: Number(f.quantity), changeFromQuantity: Number(f.current) }],
      } }), `Set to ${f.quantity}`);

    case "move": { // two changes in ONE call: minus here, plus there
      const n = Number(f.quantity);
      // not stocked there yet = 0; Shopify starts stocking it there by itself
      const level = (await run(LEVEL, { itemId: f.itemId, locationId: f.toLocationId })).inventoryLevel;
      const toCurrent = level?.quantities[0].quantity ?? 0;
      return done(await run(ADJUST, { key, input: {
        name: "available", reason: "movement_created", referenceDocumentUri: ref,
        changes: [
          { inventoryItemId: f.itemId, locationId: f.locationId, delta: -n, changeFromQuantity: Number(f.current) },
          { inventoryItemId: f.itemId, locationId: f.toLocationId, delta: n, changeFromQuantity: toCurrent },
        ],
      } }), `Moved ${n}`);
    }

    case "activate": // start stocking this item at this location
      return done(await run(ACTIVATE, { key, inventoryItemId: f.itemId, locationId: f.locationId, available: 0 }),
        "Now stocked here");

    case "location-add":
      return done(await run(LOCATION_ADD, { input: {
        name: f.name, fulfillsOnlineOrders: true,
        address: { address1: f.address1, city: f.city, zip: f.zip, countryCode: f.countryCode },
      } }), `Added ${f.name}`);
    case "location-rename":
      return done(await run(LOCATION_EDIT, { id: f.id, input: { name: f.name } }), `Renamed to ${f.name}`);
    case "location-deactivate": // its stock moves to another active location first
      return done(await run(LOCATION_DEACTIVATE, { key, locationId: f.id, destinationLocationId: f.to }),
        "Location deactivated");
    case "location-activate":
      return done(await run(LOCATION_ACTIVATE, { key, locationId: f.id }), "Location activated");
    case "location-delete":
      return done(await run(LOCATION_DELETE, { locationId: f.id }), "Location deleted");
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
const MODALS = ["adjust-modal", "set-modal", "move-modal", "location-modal"];

export default function Inventory() {
  const { locations, location, rows } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [row, setRow] = useState(null);       // the stock row a modal works on
  const [renaming, setRenaming] = useState(null); // null = add a location
  const [formKey, setFormKey] = useState(0);
  const busy = fetcher.state !== "idle";
  const others = locations.filter((l) => l.isActive && l.id !== location.id);
  const pickRef = useChange((e) => navigate(`?location=${e.currentTarget.value.split("/").pop()}`));

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      setFormKey((k) => k + 1);
      MODALS.forEach((id) => document.getElementById(id)?.hideOverlay());
    } else {
      shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const open = (id, r) => { setRow(r); setFormKey((k) => k + 1); document.getElementById(id).showOverlay(); };
  const post = (data) => fetcher.submit(data, { method: "post" });
  const submit = (intent, extra = {}) => (e) => {
    e.preventDefault();
    post({ ...Object.fromEntries(new FormData(e.currentTarget)), intent, ...extra });
  };
  const rowData = row ? { itemId: row.itemId, locationId: location.id, current: row.available } : {};

  return (
    <s-page heading="Inventory" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={() => {
        setRenaming(null); setFormKey((k) => k + 1); document.getElementById("location-modal").showOverlay();
      }}>Add location</s-button>

      {/* STOCK at one location */}
      <s-section heading={`Stock at ${location.name}`}>
        <s-select ref={pickRef} name="location" label="Location" value={location.id}>
          {locations.filter((l) => l.isActive).map((l) => <s-option key={l.id} value={l.id}>{l.name}</s-option>)}
        </s-select>
        <s-table loading={busy || undefined}>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>SKU</s-table-header>
            <s-table-header format="numeric">Available</s-table-header>
            <s-table-header format="numeric">Committed</s-table-header>
            <s-table-header format="numeric">On hand</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={r.itemId}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-thumbnail size="small" alt={r.title} src={r.image || undefined} />
                    <s-text>{r.title}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{r.sku || "—"}</s-table-cell>
                <s-table-cell>{r.stocked ? r.available : <s-badge>Not stocked</s-badge>}</s-table-cell>
                <s-table-cell>{r.stocked ? r.committed : ""}</s-table-cell>
                <s-table-cell>{r.stocked ? r.onHand : ""}</s-table-cell>
                <s-table-cell>
                  {r.stocked ? (
                    <s-button-group>
                      <s-button slot="secondary-actions" onClick={() => open("adjust-modal", r)}>Adjust</s-button>
                      <s-button slot="secondary-actions" onClick={() => open("set-modal", r)}>Set</s-button>
                      <s-button slot="secondary-actions" disabled={!others.length || undefined}
                                onClick={() => open("move-modal", r)}>Move</s-button>
                    </s-button-group>
                  ) : (
                    <s-button onClick={() => post({ intent: "activate", itemId: r.itemId, locationId: location.id })}>
                      Stock here
                    </s-button>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* LOCATIONS */}
      <s-section heading="Locations" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Location</s-table-header>
            <s-table-header>Address</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {locations.map((l) => (
              <s-table-row key={l.id}>
                <s-table-cell>{l.name}</s-table-cell>
                <s-table-cell>{[l.address.city, l.address.countryCode].filter(Boolean).join(", ")}</s-table-cell>
                <s-table-cell>
                  {l.isActive ? <s-badge tone="success">Active</s-badge> : <s-badge>Inactive</s-badge>}
                </s-table-cell>
                <s-table-cell>
                  <s-button-group>
                    <s-button slot="secondary-actions" onClick={() => {
                      setRenaming(l); setFormKey((k) => k + 1); document.getElementById("location-modal").showOverlay();
                    }}>Rename</s-button>
                    {l.isActive
                      ? <s-button slot="secondary-actions" onClick={() => post({
                          intent: "location-deactivate", id: l.id,
                          to: locations.find((o) => o.isActive && o.id !== l.id)?.id,
                        })}>Deactivate</s-button>
                      : <s-button slot="secondary-actions" onClick={() => post({ intent: "location-activate", id: l.id })}>Activate</s-button>}
                    <s-button slot="secondary-actions" tone="critical" disabled={!l.deletable || undefined}
                              onClick={() => post({ intent: "location-delete", id: l.id })}>Delete</s-button>
                  </s-button-group>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* ADJUST: + or - units */}
      <s-modal id="adjust-modal" heading={`Adjust ${row?.title || ""}`}>
        <form id="adjust-form" key={`a${formKey}`} onSubmit={submit("adjust", rowData)}>
          <s-stack gap="base">
            <s-paragraph>Available now: {row?.available}</s-paragraph>
            <s-number-field name="delta" label="Change by (use - to remove)" required value="5" />
            <s-select name="reason" label="Reason" value="received">
              <s-option value="received">Received</s-option>
              <s-option value="correction">Correction</s-option>
              <s-option value="damaged">Damaged</s-option>
              <s-option value="shrinkage">Shrinkage</s-option>
            </s-select>
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("adjust-form").requestSubmit()}>Adjust</s-button>
        <s-button slot="secondary-actions" commandFor="adjust-modal" command="--hide">Cancel</s-button>
      </s-modal>

      {/* SET: the counted number */}
      <s-modal id="set-modal" heading={`Set ${row?.title || ""}`}>
        <form id="set-form" key={`s${formKey}`} onSubmit={submit("set", rowData)}>
          <s-number-field name="quantity" label="Available (after a count)" required min={0}
                          value={String(row?.available ?? 0)} />
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("set-form").requestSubmit()}>Save</s-button>
        <s-button slot="secondary-actions" commandFor="set-modal" command="--hide">Cancel</s-button>
      </s-modal>

      {/* MOVE to another location */}
      <s-modal id="move-modal" heading={`Move ${row?.title || ""}`}>
        <form id="move-form" key={`m${formKey}`} onSubmit={submit("move", rowData)}>
          <s-stack gap="base">
            <s-select name="toLocationId" label="To location" value={others[0]?.id}>
              {others.map((l) => <s-option key={l.id} value={l.id}>{l.name}</s-option>)}
            </s-select>
            <s-number-field name="quantity" label={`Units (max ${row?.available ?? 0})`} required min={1}
                            max={row?.available ?? 0} value="1" />
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("move-form").requestSubmit()}>Move</s-button>
        <s-button slot="secondary-actions" commandFor="move-modal" command="--hide">Cancel</s-button>
      </s-modal>

      {/* ADD or RENAME a location */}
      <s-modal id="location-modal" heading={renaming ? `Rename ${renaming.name}` : "Add location"}>
        <form id="location-form" key={`l${formKey}`}
              onSubmit={renaming ? submit("location-rename", { id: renaming.id }) : submit("location-add")}>
          <s-stack gap="base">
            <s-text-field name="name" label="Name" required value={renaming?.name || ""} />
            {!renaming && (
              <>
                <s-text-field name="address1" label="Address" required />
                <s-text-field name="city" label="City" required />
                <s-text-field name="zip" label="Postal code" />
                <s-text-field name="countryCode" label="Country code" required value="US" />
              </>
            )}
          </s-stack>
        </form>
        <s-button slot="primary-action" variant="primary" loading={busy || undefined}
                  onClick={() => document.getElementById("location-form").requestSubmit()}>
          {renaming ? "Save" : "Add location"}
        </s-button>
        <s-button slot="secondary-actions" commandFor="location-modal" command="--hide">Cancel</s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
