export const ADMIN_ASSETS = [
  { pathname: "/admin/index.html", key: "admin/index.html", contentType: "text/html; charset=utf-8", maxAge: 60, source: "build" },
  { pathname: "/admin/app.js", key: "admin/app.js", contentType: "text/javascript; charset=utf-8", maxAge: 300, source: "build" },
  { pathname: "/admin/styles.css", key: "admin/styles.css", contentType: "text/css; charset=utf-8", maxAge: 300, source: "build" },
  { pathname: "/admin/favicon.png", key: "admin/favicon.png", contentType: "image/png", maxAge: 3600, source: "public" },
  { pathname: "/admin/favicon.svg", key: "admin/favicon.svg", contentType: "image/svg+xml", maxAge: 3600, source: "public" },
  { pathname: "/admin/site.webmanifest", key: "admin/site.webmanifest", contentType: "application/manifest+json; charset=utf-8", maxAge: 300, source: "public" },
  { pathname: "/admin/apple-touch-icon.png", key: "admin/apple-touch-icon.png", contentType: "image/png", maxAge: 3600, source: "public" },
  { pathname: "/admin/favicon-192.png", key: "admin/favicon-192.png", contentType: "image/png", maxAge: 3600, source: "public" },
  { pathname: "/admin/favicon-512.png", key: "admin/favicon-512.png", contentType: "image/png", maxAge: 3600, source: "public" },
  { pathname: "/admin/ribbonfish-mark.svg", key: "admin/ribbonfish-mark.svg", contentType: "image/svg+xml", maxAge: 3600, source: "public" },
  { pathname: "/admin/ribbonfish-loading.svg", key: "admin/ribbonfish-loading.svg", contentType: "image/svg+xml", maxAge: 3600, source: "public" },
  { pathname: "/admin/capture-pending.png", key: "admin/capture-pending.png", contentType: "image/png", maxAge: 3600, source: "public" },
] as const;
