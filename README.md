# Shopify App Development 2026

Source code for the **Shopify App Development 2026** YouTube series by Fayyaz Ahmed.
Each episode adds a real feature to the same embedded Shopify app (`my-store-helper`), built with
React Router, Polaris web components and the GraphQL Admin API.

Every episode has a git tag, so you can open the exact code from the video you watched.

| Episode | Video | Tag | What it adds |
|---|---|---|---|
| 01 | [How to Create a Shopify App in 2026 (Shopify CLI Step by Step)](https://youtu.be/gFDLhovNQ-E) | [`ep01`](../../tree/ep01) | App from the Shopify CLI template, running on a dev store |
| 02 | [Shopify Admin API Tutorial 2026: Create, Read, Update & Delete Products](https://youtu.be/KLpa2syFpjY) | [`ep02`](../../tree/ep02) | `app/routes/app.products.jsx`: list, search, paginate, create, edit and delete products |
| 03 | Shopify Product Variants API 2026: Add Options, Create, Update & Delete Variants (video coming soon) | [`ep03`](../../tree/ep03) | `app/routes/app.products_.$id.jsx`: options (productOptionsCreate/Delete) + variants bulk create, update (price + SKU), delete; products table links to it |

## Run it on your own dev store

You need Node.js 20.19+ (or 22.12+), a free [Shopify Partner account](https://www.shopify.com/partners) and a development store.

```bash
git clone https://github.com/fayyaz315/shopify-app-development-2026.git
cd shopify-app-development-2026
git checkout ep02            # or any episode tag; main = latest
npm install
shopify app config link      # creates or links YOUR app (client_id is blank on purpose)
shopify app dev              # pick your dev store, then open the preview link
```

The database is SQLite (Prisma); `shopify app dev` runs the migrations for you.

## Episode 02: products with the GraphQL Admin API

`app/routes/app.products.jsx` shows the full flow from API request to result:

- **Read:** `products(first/last, after/before, query: "title:*q*", sortKey: UPDATED_AT)` with cursor pagination and search.
- **Create:** `productCreate` makes the product with one default variant, but takes **no price**. The price is set on that
  variant with `productVariantsBulkUpdate` (the "price trap" from the video).
- **Update / delete:** `productUpdate` and `productDelete`, with `userErrors` shown to the merchant.
- **UI:** Polaris web components (`s-table` with pagination, `s-search-field`, `s-modal`, `s-money-field`) and an App Bridge toast.

Scopes used: `write_products` (see `shopify.app.toml`).

## Licence

MIT: use it, learn from it, ship it. Questions or a custom Shopify app: see the contact in any video description.
