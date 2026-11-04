// Cloudflare Worker (free). Set these in Worker > Settings > Variables (as secrets):
// SHOP_DOMAIN (your-store.myshopify.com), CLIENT_ID, CLIENT_SECRET, ADMIN_PASSWORD, ALLOWED_ORIGIN (e.g. https://yourname.github.io)
const API_VERSION = "2025-10";
let cached = { token: "", exp: 0 };

async function getToken(env) {
  if (cached.token && cached.exp > Date.now() + 120000) return cached.token;
  const r = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Auth failed");
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 86000) * 1000 };
  return cached.token;
}

async function gql(env, query, variables = {}) {
  const r = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getToken(env) },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error("API error");
  return j.data;
}

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
    const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname;

    try {
      // ---------- Public: products ----------
      if (path === "/products" && req.method === "GET") {
        const d = await gql(env, `{ shop { currencyCode }
          products(first: 100, query: "status:active") { nodes { id title description featuredImage { url }
            variants(first: 30) { nodes { id title price availableForSale } } } } }`);
        return out({
          currency: d.shop.currencyCode,
          products: d.products.nodes.map(p => ({
            id: p.id, title: p.title, desc: p.description, image: p.featuredImage?.url || "",
            variants: p.variants.nodes.map(v => ({ id: v.id, title: v.title, price: v.price, ok: v.availableForSale })),
          })),
        });
      }

      // ---------- Public: place order ----------
      if (path === "/order" && req.method === "POST") {
        const body = await req.json();
        if (body.website) return out({ ok: true });
        const f = body.customer || {};
        for (const k of ["name", "email", "phone", "address", "city", "zip", "country"])
          if (!String(f[k] || "").trim()) return out({ ok: false, error: "Please fill all fields" }, 400);
        const items = (body.cart || [])
          .filter(c => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(c.variantId))
          .map(c => ({ variantId: c.variantId, quantity: Math.max(1, Math.min(50, parseInt(c.qty) || 1)) }));
        if (!items.length) return out({ ok: false, error: "Cart is empty" }, 400);
        const [first, ...rest] = f.name.trim().split(" ");
        const d = await gql(env,
          `mutation($o: OrderCreateOrderInput!){ orderCreate(order:$o){ order{ name } userErrors{ message } } }`,
          { o: {
            email: f.email, phone: f.phone, lineItems: items, financialStatus: "PENDING",
            tags: ["website"], note: "Placed from website",
            shippingAddress: { firstName: first, lastName: rest.join(" ") || "-", address1: f.address, city: f.city,
              zip: f.zip, countryCode: String(f.country).slice(0, 2).toUpperCase(), phone: f.phone },
          } });
        const r = d.orderCreate;
        if (r.userErrors?.length) return out({ ok: false, error: r.userErrors[0].message }, 400);
        return out({ ok: true, order: r.order.name });
      }

      // ---------- Admin (password required) ----------
      if (path.startsWith("/admin/")) {
        if (req.headers.get("Authorization") !== `Bearer ${env.ADMIN_PASSWORD}`) return out({ error: "Unauthorized" }, 401);
        if (path === "/admin/orders") {
          const d = await gql(env, `{ orders(first: 50, sortKey: CREATED_AT, reverse: true) { nodes {
            name createdAt email displayFinancialStatus displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            shippingAddress { name address1 city zip phone }
            lineItems(first: 10) { nodes { title quantity } } } } }`);
          return out(d.orders.nodes);
        }
        if (path === "/admin/products") {
          const d = await gql(env, `{ products(first: 100) { nodes { title status totalInventory
            priceRangeV2 { minVariantPrice { amount currencyCode } } } } }`);
          return out(d.products.nodes);
        }
      }
      return out({ error: "Not found" }, 404);
    } catch (e) {
      return out({ ok: false, error: "Server error" }, 500);
    }
  },
};
