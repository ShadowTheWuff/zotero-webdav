/**
 * Minimal WebDAV server on Cloudflare Workers + R2, implementing the subset
 * of RFC 4918 that Zotero file syncing uses:
 *
 *   OPTIONS, PROPFIND (Depth 0/1), MKCOL, HEAD, GET, PUT, DELETE
 *
 * Zotero stores attachments flat under /zotero/ as <itemKey>.zip + <itemKey>.prop.
 * R2 has no real directories, so collections are implicit: any path ending in
 * "/" is treated as an existing collection, and MKCOL is a no-op success.
 */

export interface Env {
  BUCKET: R2Bucket;
  WEBDAV_USERNAME: string;
  WEBDAV_PASSWORD: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.WEBDAV_USERNAME || !env.WEBDAV_PASSWORD) {
      return new Response(
        "This server is deployed but has no credentials configured yet.\n\n" +
          "Set them with:\n" +
          "  npx wrangler secret put WEBDAV_USERNAME\n" +
          "  npx wrangler secret put WEBDAV_PASSWORD\n\n" +
          "or under Settings > Variables and Secrets on this Worker in the Cloudflare dashboard.\n",
        { status: 503, headers: { "Content-Type": "text/plain" } }
      );
    }

    if (!(await authorized(request, env))) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="zotero-webdav"' },
      });
    }

    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    // R2 key: path without the leading slash. "" means the root collection.
    const key = path.replace(/^\/+/, "");

    try {
      switch (request.method) {
        case "OPTIONS":
          return handleOptions();
        case "PROPFIND":
          return handlePropfind(env, path, key, request);
        case "MKCOL":
          return new Response(null, { status: 201 });
        case "HEAD":
        case "GET":
          return handleGet(env, key, request);
        case "PUT":
          return handlePut(env, key, request);
        case "DELETE":
          return handleDelete(env, key);
        default:
          // LOCK/UNLOCK/PROPPATCH/MOVE/COPY — not needed by Zotero.
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: ALLOWED_METHODS },
          });
      }
    } catch (err) {
      console.error(`${request.method} ${path} failed:`, err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

const ALLOWED_METHODS = "OPTIONS, PROPFIND, MKCOL, HEAD, GET, PUT, DELETE";

// ---------------------------------------------------------------------------
// Auth

async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;

  const userOk = await timingSafeEqual(decoded.slice(0, sep), env.WEBDAV_USERNAME);
  const passOk = await timingSafeEqual(decoded.slice(sep + 1), env.WEBDAV_PASSWORD);
  return userOk && passOk;
}

/** Constant-time string comparison; hashing first equalizes lengths. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

// ---------------------------------------------------------------------------
// Method handlers

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: { DAV: "1", Allow: ALLOWED_METHODS, "MS-Author-Via": "DAV" },
  });
}

async function handlePropfind(
  env: Env,
  path: string,
  key: string,
  request: Request
): Promise<Response> {
  const depth = request.headers.get("Depth") ?? "infinity";
  const isCollection = key === "" || key.endsWith("/");

  if (isCollection) {
    const responses: string[] = [collectionResponse(path)];
    if (depth !== "0") {
      const prefix = key; // "" lists the bucket root
      let cursor: string | undefined;
      do {
        const page = await env.BUCKET.list({ prefix, delimiter: "/", cursor });
        for (const dir of page.delimitedPrefixes) {
          responses.push(collectionResponse("/" + dir));
        }
        for (const obj of page.objects) {
          responses.push(fileResponse("/" + obj.key, obj));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    return multistatus(responses);
  }

  const obj = await env.BUCKET.head(key);
  if (obj) {
    return multistatus([fileResponse(path, obj)]);
  }

  // Not an object — maybe a collection referenced without a trailing slash.
  const probe = await env.BUCKET.list({ prefix: key + "/", limit: 1 });
  if (probe.objects.length > 0) {
    return multistatus([collectionResponse(path + "/")]);
  }
  return new Response("Not Found", { status: 404 });
}

async function handleGet(env: Env, key: string, request: Request): Promise<Response> {
  if (key === "" || key.endsWith("/")) {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method === "HEAD") {
    const obj = await env.BUCKET.head(key);
    if (!obj) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: objectHeaders(obj) });
  }

  const range = request.headers.has("Range") ? request.headers : undefined;
  let obj: R2ObjectBody | null;
  try {
    obj = (await env.BUCKET.get(key, { range })) as R2ObjectBody | null;
  } catch {
    return new Response("Range Not Satisfiable", { status: 416 });
  }
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = objectHeaders(obj);
  let status = 200;
  if (range && obj.range && "offset" in obj.range) {
    const offset = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    status = 206;
  }
  return new Response(obj.body, { status, headers });
}

async function handlePut(env: Env, key: string, request: Request): Promise<Response> {
  if (key === "" || key.endsWith("/")) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // R2 needs a known length to accept a stream; Zotero always sends one.
  const body = request.headers.has("Content-Length")
    ? request.body
    : await request.arrayBuffer();

  await env.BUCKET.put(key, body, {
    httpMetadata: {
      contentType: request.headers.get("Content-Type") ?? "application/octet-stream",
    },
  });
  return new Response(null, { status: 201 });
}

async function handleDelete(env: Env, key: string): Promise<Response> {
  if (key === "" || key.endsWith("/")) {
    // Deleting a collection: remove everything under the prefix.
    let cursor: string | undefined;
    do {
      const page = await env.BUCKET.list({ prefix: key, cursor });
      if (page.objects.length > 0) {
        await env.BUCKET.delete(page.objects.map((o) => o.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return new Response(null, { status: 204 });
  }

  const existing = await env.BUCKET.head(key);
  if (!existing) return new Response("Not Found", { status: 404 });
  await env.BUCKET.delete(key);
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// WebDAV XML

function multistatus(responses: string[]): Response {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<D:multistatus xmlns:D="DAV:">\n${responses.join("\n")}\n</D:multistatus>`;
  return new Response(body, {
    status: 207,
    headers: { "Content-Type": 'application/xml; charset="utf-8"' },
  });
}

function collectionResponse(href: string): string {
  return `<D:response>
  <D:href>${escapeXml(encodeHref(href))}</D:href>
  <D:propstat>
    <D:prop>
      <D:resourcetype><D:collection/></D:resourcetype>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`;
}

function fileResponse(href: string, obj: R2Object): string {
  return `<D:response>
  <D:href>${escapeXml(encodeHref(href))}</D:href>
  <D:propstat>
    <D:prop>
      <D:resourcetype/>
      <D:getcontentlength>${obj.size}</D:getcontentlength>
      <D:getlastmodified>${obj.uploaded.toUTCString()}</D:getlastmodified>
      <D:getetag>"${obj.httpEtag.replace(/"/g, "")}"</D:getetag>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`;
}

function encodeHref(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function objectHeaders(obj: R2Object): Headers {
  const headers = new Headers({
    "Content-Length": String(obj.size),
    "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
    "Last-Modified": obj.uploaded.toUTCString(),
    ETag: obj.httpEtag,
    "Accept-Ranges": "bytes",
  });
  return headers;
}
