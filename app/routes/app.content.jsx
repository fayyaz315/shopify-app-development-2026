import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Episode 11: online store content. Scopes write_content (pages, blogs, articles) + write_online_store_navigation (menus).

// ─── READ ────────────────────────────────────────────────────────────────────
const CONTENT_QUERY = `#graphql
  query Content {
    pages(first: 8, sortKey: UPDATED_AT, reverse: true) {
      nodes { id title handle isPublished }
    }
    blogs(first: 5) {
      nodes {
        id title handle
        articles(first: 5, reverse: true) {
          nodes { id title handle author { name } tags }
        }
      }
    }
    menus(first: 10) {
      nodes {
        id title handle
        items { ...Item items { ...Item items { ...Item } } }
      }
    }
  }
  fragment Item on MenuItem { id title type url resourceId }
`;

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { data } = await (await admin.graphql(CONTENT_QUERY)).json();
  return { shop: session.shop, pages: data.pages.nodes, blogs: data.blogs.nodes, menus: data.menus.nodes };
};

// ─── WRITE ───────────────────────────────────────────────────────────────────
const PAGE_CREATE = `#graphql
  mutation PageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) { page { id handle } userErrors { field message code } }
  }`;
const PAGE_UPDATE = `#graphql
  mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) { page { id isPublished } userErrors { field message code } }
  }`;
const PAGE_DELETE = `#graphql
  mutation PageDelete($id: ID!) {
    pageDelete(id: $id) { deletedPageId userErrors { field message code } }
  }`;
const BLOG_CREATE = `#graphql
  mutation BlogCreate($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) { blog { id handle } userErrors { field message code } }
  }`;
const ARTICLE_CREATE = `#graphql
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) { article { id handle } userErrors { field message code } }
  }`;
const ARTICLE_DELETE = `#graphql
  mutation ArticleDelete($id: ID!) {
    articleDelete(id: $id) { deletedArticleId userErrors { field message code } }
  }`;
// menuUpdate REPLACES the whole item list: send every item you want to keep (with its id), plus the new one
const MENU_UPDATE = `#graphql
  mutation MenuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, items: $items) {
      menu { id items { id title } }
      userErrors { field message code }
    }
  }`;

const html = (text) => text.split(/\n+/).filter(Boolean)
  .map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`).join("");
// Nested items (dropdowns) must be sent back too, or menuUpdate deletes them
const keep = ({ id, title, type, url, resourceId, items }) => ({ id, title, type, url, resourceId, items: (items ?? []).map(keep) });

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const f = Object.fromEntries(await request.formData());
  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const reply = (result, message) =>
    result.userErrors.length ? { ok: false, errors: result.userErrors } : { ok: true, message };
  const menuById = async (id) => (await gql(CONTENT_QUERY)).menus.nodes.find((m) => m.id === id);

  switch (f.intent) {
    case "createPage":
      return reply((await gql(PAGE_CREATE, { page: {
        title: f.title, handle: f.handle || undefined, body: html(f.body || ""), isPublished: f.published === "on",
      } })).pageCreate, `Page created: ${f.title}`);
    case "publish":
      return reply((await gql(PAGE_UPDATE, { id: f.id, page: { isPublished: f.value === "true" } })).pageUpdate,
        f.value === "true" ? "Page published" : "Page hidden");
    case "deletePage":
      return reply((await gql(PAGE_DELETE, { id: f.id })).pageDelete, "Page deleted");
    case "createBlog": {
      const created = (await gql(BLOG_CREATE, { blog: { title: f.title } })).blogCreate;
      return { ...reply(created, `Blog created: ${f.title}`), blogId: created.blog?.id };
    }
    case "createArticle":
      return reply((await gql(ARTICLE_CREATE, { article: {
        blogId: f.blogId, title: f.title, body: html(f.body || ""), author: { name: f.author },
        tags: (f.tags || "").split(",").map((t) => t.trim()).filter(Boolean), isPublished: true,
      } })).articleCreate, `Post published: ${f.title}`);
    case "deleteArticle":
      return reply((await gql(ARTICLE_DELETE, { id: f.id })).articleDelete, "Post deleted");
    case "addToMenu": {
      const menu = await menuById(f.menuId);
      const items = [...menu.items.map(keep), { title: f.title, type: "PAGE", resourceId: f.id }];
      return reply((await gql(MENU_UPDATE, { id: menu.id, title: menu.title, items })).menuUpdate, `Added to ${menu.title}`);
    }
    case "removeFromMenu": {
      const menu = await menuById(f.menuId);
      const items = menu.items.filter((i) => i.id !== f.id).map(keep);
      return reply((await gql(MENU_UPDATE, { id: menu.id, title: menu.title, items })).menuUpdate, `Removed from ${menu.title}`);
    }
  }
  return { ok: false, errors: [{ message: "Unknown action" }] };
};

// ─── UI (Polaris web components) ─────────────────────────────────────────────
export default function Content() {
  const { shop, pages, blogs, menus } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const [formKey, setFormKey] = useState(0);
  const [blogId, setBlogId] = useState("");  // posts of ONE chosen blog (none until you pick or create one)
  const blog = blogs.find((b) => b.id === blogId);
  const [menuId, setMenuId] = useState(menus[0]?.id ?? "");
  const menu = menus.find((m) => m.id === menuId);
  const store = `https://${shop}`;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) { shopify.toast.show(fetcher.data.message); setFormKey((k) => k + 1); if (fetcher.data.blogId) setBlogId(fetcher.data.blogId); }
    else shopify.toast.show(fetcher.data.errors.map((e) => e.message).join(", "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (intent) => (e) => {
    e.preventDefault();
    fetcher.submit({ ...Object.fromEntries(new FormData(e.currentTarget)), intent }, { method: "post" });
  };
  const send = (intent, data) => fetcher.submit({ intent, ...data }, { method: "post" });
  const inMenu = (pageId) => menu?.items.find((i) => i.resourceId === pageId);

  return (
    <s-page heading="Online store content" inlineSize="large">
      {/* PAGES */}
      <s-section heading="Pages">
        <s-stack gap="base">
          <form key={`p${formKey}`} onSubmit={submit("createPage")}>
            <s-grid gridTemplateColumns="1fr 2fr auto" gap="base" alignItems="end">
              <s-text-field name="title" label="Page title" required />
              <s-text-field name="body" label="Text" />
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-checkbox name="published" label="Published" checked />
                <s-button type="submit" variant="primary" loading={busy || undefined}>Create page</s-button>
              </s-stack>
            </s-grid>
          </form>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Page</s-table-header>
              <s-table-header>URL</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {pages.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>{p.title}</s-table-cell>
                  <s-table-cell><s-link href={`${store}/pages/${p.handle}`} target="_blank">/pages/{p.handle}</s-link></s-table-cell>
                  <s-table-cell><s-badge tone={p.isPublished ? "success" : undefined}>{p.isPublished ? "Published" : "Hidden"}</s-badge></s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {inMenu(p.id)
                        ? <s-button onClick={() => send("removeFromMenu", { menuId, id: inMenu(p.id).id })}>Remove from menu</s-button>
                        : <s-button onClick={() => send("addToMenu", { menuId, id: p.id, title: p.title })}>Add to menu</s-button>}
                      <s-button onClick={() => send("publish", { id: p.id, value: String(!p.isPublished) })}>{p.isPublished ? "Hide" : "Publish"}</s-button>
                      <s-button tone="critical" onClick={() => send("deletePage", { id: p.id })}>Delete</s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>

      {/* MENUS: "Add to menu" above uses the menu chosen here */}
      <s-section heading="Menu">
        <s-stack gap="base">
          <s-select label="Menu for Add / Remove" value={menuId} onChange={(e) => setMenuId(e.currentTarget.value)}>
            {menus.map((m) => <s-option key={m.id} value={m.id}>{m.title}</s-option>)}
          </s-select>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Link</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Goes to</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {(menu?.items ?? []).map((i) => (
                <s-table-row key={i.id}>
                  <s-table-cell>{i.title}{i.items.length ? ` (+${i.items.length} inside)` : ""}</s-table-cell>
                  <s-table-cell><s-badge>{i.type}</s-badge></s-table-cell>
                  <s-table-cell>{i.url}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>
      {/* BLOG POSTS */}
      <s-section heading="Blog posts">
        <s-stack gap="base">
          <form key={`b${formKey}`} onSubmit={submit("createBlog")}>
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
              <s-text-field name="title" label="New blog" placeholder="Blog name" />
              <s-button type="submit" loading={busy || undefined}>Create blog</s-button>
            </s-grid>
          </form>
          <form key={`a${formKey}`} onSubmit={submit("createArticle")}>
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base" alignItems="end">
              <s-select name="blogId" label="Blog" value={blogId} onChange={(e) => setBlogId(e.currentTarget.value)}>
                <s-option value="">Choose a blog</s-option>
                {blogs.map((b) => <s-option key={b.id} value={b.id}>{b.title}</s-option>)}
              </s-select>
              <s-text-field name="title" label="Post title" required />
              <s-text-field name="author" label="Author" required />
              <s-text-field name="body" label="Text" />
              <s-text-field name="tags" label="Tags" details="Separate tags with commas" />
              <s-button type="submit" variant="primary" loading={busy || undefined}>Publish post</s-button>
            </s-grid>
          </form>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Post</s-table-header>
              <s-table-header>Blog</s-table-header>
              <s-table-header>Author</s-table-header>
              <s-table-header>Tags</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {(blog ? [blog] : []).flatMap((b) => b.articles.nodes.map((a) => (
                <s-table-row key={a.id}>
                  <s-table-cell><s-link href={`${store}/blogs/${b.handle}/${a.handle}`} target="_blank">{a.title}</s-link></s-table-cell>
                  <s-table-cell>{b.title}</s-table-cell>
                  <s-table-cell>{a.author?.name}</s-table-cell>
                  <s-table-cell>{a.tags.join(", ") || "—"}</s-table-cell>
                  <s-table-cell><s-button tone="critical" onClick={() => send("deleteArticle", { id: a.id })}>Delete</s-button></s-table-cell>
                </s-table-row>
              )))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
