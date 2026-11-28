import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/collections">Collections</s-link>
        <s-link href="/app/inventory">Inventory</s-link>
        <s-link href="/app/discounts">Discounts</s-link>
        <s-link href="/app/metafields">Metafields</s-link>
        <s-link href="/app/metaobjects">Metaobjects</s-link>
        <s-link href="/app/webhooks">Webhooks</s-link>
        <s-link href="/app/files">Files</s-link>
        <s-link href="/app/content">Content</s-link>
        <s-link href="/app/languages">Languages</s-link>
        <s-link href="/app/shipping">Shipping</s-link>
        <s-link href="/app/customers">Customers</s-link>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/fulfillments">Fulfillments</s-link>
        <s-link href="/app/themes">Themes</s-link>
        <s-link href="/app/storefront">Storefront</s-link>
        <s-link href="/app/additional">Additional page</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
