import { app, protocol } from "electron";
import { promises as fs } from "node:fs";
import { extname, join, normalize, relative } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".moc3": "application/octet-stream",
  ".wasm": "application/wasm",
};

const APP_SCHEME = "app";
const APP_HOST = "bundle";

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function registerAppProtocol(): void {
  const root = join(app.getAppPath(), "out", "renderer");

  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== APP_HOST) {
        return new Response("Not found", { status: 404 });
      }

      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/" || pathname === "") pathname = "/index.html";

      const target = normalize(join(root, pathname));
      const rel = relative(root, target);
      if (rel.startsWith("..") || rel.includes(`..${"/"}`) || rel === "") {
        return new Response("Forbidden", { status: 403 });
      }

      const data = await fs.readFile(target);
      const type = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": type,
          "Cache-Control": "no-cache",
        },
      });
    } catch (error) {
      console.warn("[app-protocol] failed", error);
      return new Response("Not found", { status: 404 });
    }
  });
}

export function appEntryUrl(): string {
  return `${APP_SCHEME}://${APP_HOST}/index.html`;
}
