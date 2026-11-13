# Ribbonfish brand assets

Ribbonfish uses two coordinated but distinct **original vector marks**. The formal identity is a ribbonfish whose silver-to-cyan body sweeps into an S; the secondary loading mascot is a fish flowing around a continuous infinity loop. Both are rebuilt as editable SVG shapes with gradients, **not PNGs embedded inside SVGs**.

## Official identity: Ribbon S

![Ribbon S vector mark](../workers/device-sync/public/admin/ribbonfish-mark.svg)

Use the **Ribbon S** in the management UI, docs, headers and product branding. Its recognisable features are the long silvery head, four aqua dorsal fins, deep navy outlines, expressive eye, dark gill contour and the curled cyan tail.

## Secondary mascot: Infinity Ribbon

![Infinity Ribbon vector mascot](../workers/device-sync/public/admin/ribbonfish-loading.svg)

Use the **Infinity Ribbon** as loading and capture art, not as the default product logo. It has its own vector silhouette and is animated gently by the management UI's CSS. The animation stops under `prefers-reduced-motion: reduce`. The asset can be displayed statically elsewhere.

## Favicon

![Ribbonfish favicon](../workers/device-sync/public/admin/favicon.svg)

The favicon is a separately simplified vector, designed for 16–64 px tab sizes. It preserves the S motif, navy rounded-square background, eye and cyan fins without requiring details that are illegible at small sizes. `favicon.png` is a matching 64×64 PNG fallback.

## Source assets and usage

| Asset | Usage |
| --- | --- |
| `workers/device-sync/public/admin/ribbonfish-mark.svg` | Official standalone logo / management header |
| `workers/device-sync/public/admin/ribbonfish-loading.svg` | Loading and capture mascot / CSS animation |
| `workers/device-sync/public/admin/favicon.svg` | Preferred browser favicon |
| `workers/device-sync/public/admin/favicon.png` | Legacy PNG favicon fallback |

The management Worker serves these under `/admin/`. The existing `npm run publish:admin:local` and `npm run publish:admin:production` commands upload the SVGs and PNG to R2. The loading overlay is included in the markup and a `setRibbonfishLoading(boolean)` helper is available for integration with asynchronous operations, but it is hidden by default.

## Palette

- Navy outlines: `#07365a`, `#0b2943`
- Cyan and aqua fins: `#00fbed`, `#16dbeb`
- Blue ribbon: `#007db9`, `#168abb`
- Silver / white highlights: `#ecfbff`, `#f9feff`

Never stretch the artwork out of aspect ratio or add dashboard/pixel motifs inside the official mark. Use the simplified favicon at small sizes, rather than shrinking the detailed full mark. Keep animations non-essential and honour reduced-motion preferences.
