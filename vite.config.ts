import react from "@vitejs/plugin-react";
import { MongoClient } from "mongodb";
import { readdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { defineConfig, loadEnv, type Logger, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const FUNCTIONS_DIR = new URL("./netlify/functions/", import.meta.url).pathname;

/** "/api/events/:id" vs "/api/events/evt_1" → { id: "evt_1" }, or null when it doesn't match. */
function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = (pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname).split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body });
}

/** At dev-server start, say plainly if the database the API needs isn't there or is empty. */
async function checkDatabase(logger: Logger): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    logger.warn("\n  MONGODB_URI isn't set: copy .env.example to .env\n");
    return;
  }
  const where = uri.replace(/\/\/[^@/]*@/, "//***@"); // never print a password
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const events = await client.db(process.env.MONGODB_DB || "wpg_events").collection("events").estimatedDocumentCount();
    if (events === 0) logger.warn(`\n  MongoDB at ${where} has no events yet: run the crawler (README → Run it locally)\n`);
  } catch {
    logger.warn(`\n  Can't reach MongoDB at ${where}.\n  Start one with \`npm run db:local\` in another terminal, or point MONGODB_URI in .env at a running one.\n`);
  } finally {
    await client.close();
  }
}

/**
 * `npm run dev:web` without the Netlify CLI: answers /api/* with the functions in netlify/functions,
 * matched by their `config.path`. `npm run dev` (netlify dev) is the faithful version, with the
 * image CDN and Netlify's routing.
 */
function netlifyFunctionsDev(): Plugin {
  return {
    name: "netlify-functions-dev",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.once("listening", () => void checkDatabase(server.config.logger));
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!pathname.startsWith("/api/")) return next();
        try {
          for (const file of readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith(".mts"))) {
            const mod = await server.ssrLoadModule(FUNCTIONS_DIR + file);
            for (const pattern of [mod.config?.path].flat().filter(Boolean) as string[]) {
              const params = matchPath(pattern, pathname);
              if (!params) continue;
              const response: Response = await mod.default(await toRequest(req), { params });
              res.statusCode = response.status;
              response.headers.forEach((value, key) => res.setHeader(key, value));
              res.setHeader("cache-control", "no-store"); // in development, always fresh (production caches the feed)
              res.end(Buffer.from(await response.arrayBuffer()));
              return;
            }
          }
          next();
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // the functions read MONGODB_URI etc. from process.env, as they do on Netlify
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  if (mode === "production" && !process.env.VITE_PRIVACY_EMAIL) {
    console.warn("\n  VITE_PRIVACY_EMAIL isn't set: the privacy notice has no contact address (README → Privacy)\n");
  }
  return {
    root: "web",
    build: { outDir: "dist", emptyOutDir: true },
    plugins: [
      react(),
      netlifyFunctionsDev(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["favicon.svg"],
        manifest: {
          name: "Winnipeg Events",
          short_name: "WPG Events",
          description: "Swipe through what's on in Winnipeg",
          theme_color: "#FFE14D",
          background_color: "#FFE14D",
          display: "standalone",
          start_url: "/",
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
            { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          navigateFallbackDenylist: [/^\/api\//, /^\/\.netlify\//],
          runtimeCaching: [
            {
              // the feed (one per city) and the city list: fresh when online, the last copy when offline
              urlPattern: ({ url }) => url.pathname === "/api/events" || url.pathname === "/api/cities",
              handler: "NetworkFirst",
              options: { cacheName: "events", networkTimeoutSeconds: 4, expiration: { maxEntries: 8, maxAgeSeconds: 2 * 86400 } },
            },
            {
              // the self-hosted fonts (hashed file names, so a cached copy never goes stale)
              urlPattern: ({ request, sameOrigin }) => sameOrigin && request.destination === "font",
              handler: "CacheFirst",
              options: { cacheName: "fonts", expiration: { maxEntries: 20 } },
            },
            {
              urlPattern: ({ url }) => url.pathname.startsWith("/.netlify/images"),
              handler: "CacheFirst",
              options: {
                cacheName: "images",
                expiration: { maxEntries: 400, maxAgeSeconds: 7 * 86400 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
  };
});
