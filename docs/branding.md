# Ribbonfish brand assets

Ribbonfish uses two coordinated but distinct marks inspired by an elongated ribbonfish.

- **Ribbon S** — official product identity, shown in the management header and the favicon. Its curved, streamlined silhouette forms a loose S.
- **Infinity Ribbon** — secondary mascot, reserved for loading, capture and refresh states. The loop suggests ongoing capture and dashboard rotation.

## Source assets

All source SVGs live under `workers/device-sync/public/admin/` and use transparent backgrounds except for the dark square favicon.

| Asset | Intended use |
| --- | --- |
| `ribbonfish-mark.svg` | Official primary identity (transparent) |
| `favicon.svg` | Modern browser tab icon (dark navy background) |
| `ribbonfish-loading.svg` | Animated loader through CSS; stationary fallback when reduced motion is requested |

The management Worker publishes these SVG files to R2 via `npm run publish:admin:local` or `npm run publish:admin:production` and serves them at `/admin/<filename>`.

## Styling

- Navy ink: `#0c304d` / icon background `#0b2943`
- Cyan: `#45d2ec`
- Aqua: `#41f7e9`
- White highlight: `#f5fdff`

Keep original proportions when resizing. Avoid adding dashboard graphics to the formal mark or using the animated mascot as the primary favicon. The loader is decorative; its accompanying text provides the accessible status. Respect `prefers-reduced-motion`.
