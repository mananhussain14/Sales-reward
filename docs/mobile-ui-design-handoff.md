# Mobile UI Design Handoff — SalesReward

## Backend source version

| Field | Value |
| --- | --- |
| Repository | `salesreward-admin` (Next.js 16.2.10 + Supabase) |
| Branch | `main` |
| Commit | `510331e5fed8293f6af95c339fee8c082b4ea458` |
| Latest migration | `supabase/migrations/20260728090000_retailer_staff_registration_context.sql` |
| Date of audit | 2026-07-24 |

Companion documents: [`mobile-backend-contract.md`](./mobile-backend-contract.md),
[`mobile-feature-matrix.md`](./mobile-feature-matrix.md),
[`mobile-architecture-recommendation.md`](./mobile-architecture-recommendation.md),
[`mobile-role-flow-map.md`](./mobile-role-flow-map.md).

**Status: audit and specification only.** No migration, RLS policy, RPC, application
file, or environment file was read-modified. Everything below was derived by reading the
shipped web source.

**Purpose.** Flutter must look like *the same SalesReward product*, not a new theme
inspired by it. This document records the exact visual identity so a Flutter engineer can
reproduce it without opening the web codebase, and marks the small number of places where
the web itself is inconsistent and a decision is required.

---

## 0. Where the design system actually lives

There is no `tailwind.config.*`. The project is on **Tailwind CSS v4**, which is
configured in CSS.

| Concern | Source of truth |
| --- | --- |
| Custom CSS variables, shadows, keyframes, reduced-motion rules | `app/globals.css` |
| Colour / spacing / radius / type scales | Tailwind v4 defaults (`node_modules/tailwindcss/theme.css`) |
| Fonts | `app/layout.tsx` — `next/font/google` Geist + Geist Mono |
| Buttons | `components/ui/button.tsx` |
| Cards / section cards | `components/ui/card.tsx` |
| Inputs, selects, textareas, labels, errors | `components/ui/field.tsx` |
| Badges + backend-status → label/tone map | `components/ui/badge.tsx` |
| Inline alerts | `components/ui/alert.tsx` |
| Empty / unavailable states | `components/ui/empty-state.tsx` |
| Skeletons | `components/ui/skeleton.tsx` |
| Page + section headers, back link | `components/ui/page-header.tsx` |
| Brand mark and lockup | `components/ui/brand.tsx` |
| Vendor shell / sidebar / header | `components/admin/*` |
| Retailer shell + nav | `components/retailer-portal/*` |
| Access-denied surface | `components/ui/access-denied-card.tsx` |
| Invitation surface | `components/ui/invitation-shell.tsx` |

The design system is asserted by source-level tests in `lib/ui/*.test.ts`. If Flutter
diverges from a value below, the web test suite is the tiebreaker.

### The product is light-only, deliberately

`app/globals.css` redefines the `dark:` variant to key off an explicit `.dark` class that
is **never applied**, and sets `html { color-scheme: light }`. Every historical `dark:`
utility in the codebase is therefore inert.

> **Flutter: ship light theme only for this milestone.** Set
> `ThemeMode.light` explicitly rather than `ThemeMode.system`. Do not author a dark
> `ColorScheme` "for later" — the web has no dark palette to copy, so any dark theme
> would be invented, which is exactly what this handoff exists to prevent.

---

## 1. Brand identity

### Application name

**SalesReward**. One word, capital S, capital R, no space, no hyphen. It appears as:

- the wordmark beside the brand mark (`BrandLockup`);
- page titles — `"Sign in · SalesReward"`, `"Dashboard · SalesReward Admin"` (middle dot
  `·` U+00B7, spaced);
- the sidebar footer — `"SalesReward · v0.1"`;
- the login footer — `"Secure sign-in · SalesReward"`.

The two portals are named in UI chrome, never as separate products:

| Surface | Name shown |
| --- | --- |
| Vendor sidebar caption + header title | **Vendor Admin** |
| Retailer sidebar caption | **Retailer** |
| Retailer header title | **Retailer Portal** |

### Logo

The mark is **inline SVG, not an asset** (`components/ui/brand.tsx`). There is no PNG,
no SVG file, and no network request. `public/` contains no logo. Flutter should
reproduce it as a widget (`CustomPaint`, or an inlined SVG string) rather than shipping a
raster.

Geometry, on a 40 × 40 viewBox:

| Element | Spec |
| --- | --- |
| Tile | `rect 0 0 40 40`, corner radius **11** (27.5% of edge) |
| Tile fill | linear gradient, `(0,0) → (40,40)`, `#4F46E5` → `#7C3AED` |
| Bar 1 | `x=10 y=23 w=3.6 h=7 rx=1.4`, fill `#C7D2FE` |
| Bar 2 | `x=16 y=19 w=3.6 h=11 rx=1.4`, fill `#E0E7FF` |
| Bar 3 / arrow shaft | stroke `#FFFFFF`, width **3.6**, round cap, `M24 30 V15.5` |
| Arrow head | stroke `#FFFFFF`, width **3.2**, round cap+join, `M20 18.5 L24 14.5 L28 18.5` |
| Reward spark | four-point star at `(29.5, 13)`, fill `#F59E0B` |

Rendered sizes in use: **36 px** (sidebar lockup), **40 px** (login mobile, invitation,
access-denied), **44 px** (login marketing panel).

Lockup rules:

- mark and wordmark sit in a row with a **10 px** gap (`gap-2.5`);
- wordmark is `0.95rem` (15.2 px), weight 600, `tracking-tight`, colour slate-900 — except
  on the login marketing panel, where it is `1.125rem` white;
- an optional context caption sits under the wordmark: `0.7rem` (11.2 px), weight 500,
  **uppercase**, `tracking-wide`, slate-500, 4 px above.

The mark is `role="img"` with `aria-label="SalesReward"`. In Flutter, wrap it in
`Semantics(label: 'SalesReward', image: true)`.

### Brand personality and visual tone

Stated in the source and consistently executed:

- **Growth + reward — trust and commerce, not gaming.** The mark is a rising sales chart,
  not a trophy or a coin.
- **Premium and calm.** Layered low-opacity shadows tinted slate rather than black; a
  hairline-bordered white card on a slate-50 page; generous 20–24 px card padding.
- **Restrained motion.** A 220 ms fade-in on route content, a 280 ms spring pop for
  success, a one-shot line draw and a slow float on the login artwork. Everything is
  disabled under a reduced-motion preference.
- **Honest and non-leaking.** An unknown count renders `"Unavailable"`, never `0` or
  `—`. An unrecognised status enum renders `"Unknown"`, never the raw value. Denial
  screens name no role, organization, or failing condition.
- **Never colour alone.** Every status pairs a hue with a text label, and key states add
  an icon. The active nav item gets an indigo rail *as well as* a tinted background.

> **Flutter must preserve the honesty rules, not just the colours.** They are security
> and accessibility decisions the web made on purpose, and they are cheap to lose in a
> port.

---

## 2. Design tokens

### 2.1 A colour caveat you must read first

Two colour systems coexist in the shipped web app:

1. **Tailwind v4 utility classes** (`bg-indigo-600`, `text-slate-500`, …) resolve to
   Tailwind v4's **OKLCH** palette.
2. **Hard-coded hex literals** in `app/globals.css` and the brand SVG, which are
   Tailwind **v3-era** hexes.

They are close but not identical. The most visible case:

| Thing | Value | Source |
| --- | --- | --- |
| Brand mark gradient | `#4F46E5` → `#7C3AED` | hard-coded SVG literal |
| Header/avatar gradient (`from-indigo-500 to-violet-600`) | `#615FFF` → `#7F22FE` | Tailwind v4 utility |
| `--brand` CSS variable | `#4F46E5` | `globals.css` literal |
| `bg-indigo-600` button fill | `#4F39F6` | Tailwind v4 utility |

**→ Product decision required (D-1).** See § 6. Until it is answered, the recommendation
below is: **use the Tailwind v4 column for everything except the brand mark, and keep the
mark's literals exactly as they are** — that reproduces what a user actually sees today,
pixel for pixel.

All hexes below are sRGB, computed from the OKLCH definitions in
`node_modules/tailwindcss/theme.css`.

### 2.2 Core palette

| Token | Tailwind class | Hex (v4, as rendered) | Used for |
| --- | --- | --- | --- |
| `slate-50` | `bg-slate-50` | `#F8FAFC` | app background, table header strip, muted card |
| `slate-100` | `bg-slate-100` | `#F1F5F9` | hover fill, divider, neutral disc, "Soon" pill |
| `slate-200` | `border-slate-200` | `#E2E8F0` | **the** hairline border; skeleton base; separators |
| `slate-300` | `border-slate-300` | `#CAD5E2` | input border, dashed empty-state border, upcoming node |
| `slate-400` | `text-slate-400` | `#90A1B9` | placeholder, disabled nav label, stat hint |
| `slate-500` | `text-slate-500` | `#62748E` | secondary/supporting text — the workhorse |
| `slate-600` | `text-slate-600` | `#45556C` | nav item label, table body text, ghost button |
| `slate-700` | `text-slate-700` | `#314158` | outline-button label, emphasised inline value |
| `slate-800` | `text-slate-800` | `#1D293D` | form field label |
| `slate-900` | `text-slate-900` | `#0F172B` | primary text, headings, secondary button fill |
| `white` | `bg-white` | `#FFFFFF` | every card/surface, sidebar, header |

### 2.3 Semantic tokens

| Role | Class | Hex | Notes |
| --- | --- | --- | --- |
| **Background** | `bg-slate-50` | `#F8FAFC` | every authenticated screen and the auth screens |
| Background (secondary) | `bg-slate-100` | `#F1F5F9` | declared as `--app-background-secondary`; rarely used |
| **Surface** | `bg-white` | `#FFFFFF` | cards, sidebar, sheet, table body |
| Surface (sticky header) | `bg-white/85` + `backdrop-blur-md` | 85 % white | app bar only |
| Surface (nav, dark) | `--surface-nav` | `#0F172A` | **declared but unused** — the shipped sidebar is white. Do not build a dark drawer from it. |
| **Border** | `border-slate-200` | `#E2E8F0` | default hairline, 1 px |
| Border (strong) | `border-slate-300` | `#CAD5E2` | inputs, dashed empty state |
| **Primary** | `indigo-600` | `#4F39F6` | primary button, active nav, focus ring, eyebrow, links |
| Primary (hover) | `indigo-700` | `#432DD7` | primary button hover |
| Primary (soft) | `indigo-50` | `#EEF2FF` | active nav fill, icon discs, info panels |
| **Secondary** | `slate-900` | `#0F172B` | the "secondary" button variant is a dark solid |
| Accent | `violet-600` | `#7F22FE` | gradient partner for avatars and the nav progress bar |

### 2.4 Status colours

Each family is used as `-50` fill / `-600` or `-700` text / `-600 @ 20 %` ring.

| Intent | Fill | Text | Ring / border | Icon |
| --- | --- | --- | --- | --- |
| **Success** (emerald) | `#ECFDF5` | `#007A55` (700) | `#009966` @ 20 % | check |
| **Warning** (amber) | `#FFFBEB` | `#BB4D00` (700) | `#E17100` @ 20 % | triangle |
| **Error** (red) | `#FEF2F2` | `#C10007` (700) | `#E7000B` @ 20 % | triangle |
| **Info** (blue) | `#EFF6FF` | `#1447E6` (700) | `#155DFC` @ 20 % | info circle |
| **In progress** (indigo) | `#EEF2FF` | `#432DD7` (700) | `#4F39F6` @ 20 % | — |
| **Neutral** (slate) | `#F1F5F9` | `#45556C` (600) | `#62748E` @ 20 % | — |

Alert containers use `-200` borders and `-900` text on a `-50` fill (error is the one
exception: `text-red-800` `#9F0712`, for contrast). Alert icons use the `-600` tint.

Additional error tokens: field error text `text-red-700` `#C10007`; invalid input border
`border-red-400` `#FF6467`; danger button `bg-red-600` `#E7000B`, hover `red-700`.

### 2.5 Text colours

| Use | Class | Hex |
| --- | --- | --- |
| Heading / primary body | `text-slate-900` | `#0F172B` |
| Form label | `text-slate-800` | `#1D293D` |
| Body / table cell | `text-slate-600` | `#45556C` |
| Supporting / description / hint | `text-slate-500` | `#62748E` |
| Placeholder, stat hint, footer | `text-slate-400` | `#90A1B9` |
| On primary / on dark | `text-white` | `#FFFFFF` |
| Link-ish inline | `text-indigo-600` | `#4F39F6` |
| Eyebrow | `text-indigo-600`, uppercase, `tracking-wide`, 600 | `#4F39F6` |

### 2.6 Disabled colours

There is no separate disabled palette — the web uses opacity plus a fill change.

| Element | Treatment |
| --- | --- |
| Button (disabled/loading) | `opacity: 0.6`, shadow removed, hover-lift suppressed, `cursor: not-allowed` |
| Input / select / textarea | `opacity: 0.7`, background → `slate-50` `#F8FAFC` |
| Nav item ("Coming soon") | `text-slate-400` `#90A1B9`, not a link, `title="Coming soon"`, trailing "Soon" pill |
| Back link (disabled) | `opacity: 0.6`, pointer events off |
| Empty-state icon disc | `slate-100` fill, `slate-500` glyph |

> Flutter: `Opacity(0.6)` on the whole button, and `fillColor: slate-50` +
> `Opacity(0.7)` on a disabled field. Do **not** substitute Material's default grey.

### 2.7 Shadows

Custom, defined in `app/globals.css` `@theme inline`. All are tinted with slate-900
(`rgb(15 23 42)`), never neutral black — this is what makes the product read "premium"
rather than "Material default".

| Token | Value |
| --- | --- |
| `shadow-card` | `0 1px 2px 0 rgb(15 23 42 / .04)`, `0 1px 3px 0 rgb(15 23 42 / .06)` |
| `shadow-elevated` | `0 4px 12px -2px rgb(15 23 42 / .08)`, `0 2px 6px -2px rgb(15 23 42 / .05)` |
| `shadow-modal` | `0 20px 40px -12px rgb(15 23 42 / .22)`, `0 8px 16px -8px rgb(15 23 42 / .12)` |
| `shadow-brand` | `0 8px 24px -6px rgb(79 70 229 / .35)` *(declared; not currently applied)* |
| `shadow-sm` (Tailwind) | `0 1px 3px 0 rgb(0 0 0 / .1)`, `0 1px 2px -1px rgb(0 0 0 / .1)` — buttons, inputs, avatars |

Flutter equivalents (two `BoxShadow`s each, `color: Color(0xFF0F172A).withOpacity(a)`):

```
shadow-card      → [ (0,1) blur 2 spread 0 α.04, (0,1) blur 3 spread 0 α.06 ]
shadow-elevated  → [ (0,4) blur 12 spread -2 α.08, (0,2) blur 6 spread -2 α.05 ]
shadow-modal     → [ (0,20) blur 40 spread -12 α.22, (0,8) blur 16 spread -8 α.12 ]
```

Note CSS blur ≈ 2 × Flutter `blurRadius` is a common conversion myth; Flutter's
`blurRadius` maps to the CSS blur value directly for `BoxShadow`. Verify against a
screenshot rather than trusting either rule.

### 2.8 Border radii

| Token | px | Where |
| --- | --- | --- |
| `rounded-lg` | 8 | small inline controls, "Replace" chip, skip-link |
| `rounded-xl` | 12 | **buttons**, **inputs/selects/textareas**, alerts, info panels, icon discs (10 × 10), nav items, icon buttons |
| `rounded-2xl` | 16 | **cards**, tables (clipped), empty states, upload target, larger discs (11–14) |
| `rounded-full` | ∞ | badges, avatars, timeline nodes, stage indicator, "Soon" pill, active nav rail |
| Brand tile | 11 / 40 edge | the mark only |

There are **three** radii to internalise: **12 for controls, 16 for surfaces, full for
pills.** Nothing in the product uses 4 or 24.

### 2.9 Spacing scale

Tailwind v4 base unit is `0.25rem = 4px`; utility `n` → `4n` px.

| Context | Value |
| --- | --- |
| Field label → control, control → message | `space-y-2` = **8** |
| Between fields in a form | `space-y-5` = **20** |
| Card padding | `p-5` (20) → `sm:p-6` (24); auth cards `p-6` → `sm:p-8` (32) |
| Grid gutter (stat cards, form columns) | `gap-4` = **16** |
| Section stack on a page | `space-y-6` (24) or `space-y-8` (32) |
| Table cell | `px-4 py-3` = 16 / 12 |
| Nav item | `px-3 py-2` = 12 / 8, `gap-3` = 12 between icon and label |
| App bar / sidebar header height | `h-16` = **64** |
| Main content padding | `px-4 py-6` → `sm:px-6` → `lg:px-8` (16/24/32 h, 24 v) |
| Sidebar width | `w-64` = **256** |
| Content max width | `max-w-6xl` = **1152** (dashboards/lists), `max-w-2xl`/`max-w-3xl` (forms), `max-w-md` = 448 (auth/invitation), `max-w-sm` = 384 (login form) |

### 2.10 Icon sizing

All icons are 24 × 24 viewBox, `fill="none"`, `stroke="currentColor"`,
`stroke-width={1.75}`, round cap and join (`components/ui/icons.tsx`, 38 icons).

| Rendered size | Where |
| --- | --- |
| `h-3 w-3` = 12 | inside a status badge |
| `h-3.5 w-3.5` = 14 | timeline node, stage indicator, benefit check |
| `h-4 w-4` = 16 | inline in buttons, alerts, back link, spinner, chevrons |
| `h-5 w-5` = 20 | **nav items**, stat-card disc glyph, hamburger |
| `h-6 w-6` = 24 | empty-state disc, invitation disc, upload disc |
| `h-7 w-7` = 28 | access-denied shield |

Icon discs: `h-10 w-10 rounded-xl` (stat/detail/shortcut), `h-11 w-11 rounded-2xl`
(status card, form step), `h-12 w-12 rounded-2xl` (invitation, upload), `h-14 w-14
rounded-2xl` (empty state, access denied).

> Flutter: **do not use Material Icons.** The stroke weight (1.75 on a 24 grid) and the
> round caps are a large part of the product's look, and Material's filled/outlined set
> will read as a different app. Port the 38 paths from `components/ui/icons.tsx` and
> render them with a stroking painter, or use `flutter_svg` over inlined strings. The
> icon set already covers everything: dashboard, retailers/shop, users/staff, roles,
> products, receipt, audit, settings, plus, search, upload, check, check-circle,
> alert-triangle, info, x, chevron-left/right, menu, mail, location, calendar, clock,
> sign-out, shield, reward, trending-up, arrow-up-right, building, inbox, document, key,
> user-plus, send, store, spinner.

### 2.11 Typography

Fonts are **Geist** (sans) and **Geist Mono**, loaded via `next/font/google` in
`app/layout.tsx`, with fallback chain `ui-sans-serif, system-ui, -apple-system, "Segoe
UI", Roboto, Arial, sans-serif`. Body sets `-webkit-font-smoothing: antialiased` and
`text-rendering: optimizeLegibility`.

Geist Mono is loaded but **never actually applied** to any element in the shipped UI.

> Flutter: bundle Geist (`google_fonts` or a bundled `.ttf`). Falling back to Roboto/SF
> will visibly change the product. Geist Mono can be skipped.

| Role | Size | Weight | Extras | Colour |
| --- | --- | --- | --- | --- |
| Page title (`PageHeader`) | `text-2xl` 24 px | 600 | `tracking-tight` | slate-900 |
| Auth title ("Welcome back") | `text-2xl` 24 px | 600 | `tracking-tight` | slate-900 |
| Invitation / access-denied title | `text-xl` 20 px | 600 | `tracking-tight` | slate-900 |
| Section heading (`SectionHeader`) | `text-lg` 18 px | 600 | `tracking-tight` | slate-900 |
| Marketing headline (login panel) | `text-2xl` 24 px | 600 | `leading-snug` | white |
| Card title (`SectionCard`) | `text-base` 16 px | 600 | — | slate-900 |
| App bar title | `text-base` 16 px | 600 | truncate | slate-900 |
| Stat value | `text-3xl` 30 px | 600 | `tabular-nums` | slate-900 |
| Stat value (unavailable) | `text-lg` 18 px | 500 | — | slate-400 |
| Body / table / alert / button | `text-sm` 14 px | 400 | — | slate-600 / slate-900 |
| Button label | `text-sm` 14 px (`lg`: 16) | **600** | — | per variant |
| Field label | `text-sm` 14 px | 500 | — | slate-800 |
| Field error | `text-sm` 14 px | 500 | — | red-700 |
| Nav item | `text-sm` 14 px | 500 | — | slate-600 / indigo-700 |
| Identity name (app bar) | `text-sm` 14 px | 500 | truncate | slate-900 |
| Hint / caption / table header | `text-xs` 12 px | 400 (header 600) | header: uppercase + `tracking-wide` | slate-500 |
| Badge | `text-xs` 12 px | 500 | — | tone-700 |
| Eyebrow | `text-xs` 12 px | 600 | uppercase + `tracking-wide` | indigo-600 |
| Brand wordmark | 15.2 px | 600 | `tracking-tight` | slate-900 |
| Brand context caption | 11.2 px | 500 | uppercase + `tracking-wide` | slate-500 |
| Stage-indicator label | 11.2 px | 500 | — | indigo-700 / slate-400 |
| "Soon" pill | 10 px | 600 | uppercase + `tracking-wide` | slate-500 |

Tailwind default line heights apply: `text-xs` → 1.333, `text-sm` → 1.4286, `text-base`
→ 1.5, `text-lg` → 1.556, `text-xl` → 1.4, `text-2xl` → 1.333, `text-3xl` → 1.2.
`tracking-tight` = −0.025em; `tracking-wide` = +0.025em.

### 2.12 Motion

| Name | Spec | Used by |
| --- | --- | --- |
| `sr-animate-fade-in` | 220 ms `ease-out`, opacity 0→1 + `translateY(4px)`→0 | `<main>` on every route; success alerts |
| `sr-animate-pop` | 280 ms `cubic-bezier(.34,1.56,.64,1)`, scale .6→1.08→1 | success confirmations |
| `sr-check-draw` | 360 ms `ease-out`, 120 ms delay, dash 24→0 | drawn check marks |
| `sr-skeleton` shimmer | 1.4 s linear loop, white 65 % sweep over `#E2E8F0` | all skeletons |
| `sr-nav-progress` | 1.15 s `ease-in-out` loop, indeterminate 2 px bar, `#4F46E5`→`#7C3AED` gradient, glow `0 0 8px rgb(79 70 229 / .5)` | top-of-screen route progress |
| `sr-draw-line` | 1.6 s `ease-out`, 150 ms delay, one-shot | login artwork |
| `sr-animate-float` | 4.5 s `ease-in-out` loop, ±6 px | login reward spark |
| Button press | `active:translate-y-px` | all solid/outline buttons |
| Card hover (interactive) | 150 ms — lift 2 px, border → indigo-300, shadow → elevated | stat cards, shortcuts, list rows |

**Reduced motion is honoured globally**: all durations collapse to 0.001 ms, the skeleton
shimmer is removed entirely, and the nav progress bar becomes a static full-width bar at
85 % opacity. Flutter must check `MediaQuery.disableAnimations` /
`accessibleNavigation` and do the same — in particular, keep a *visible static* progress
indicator rather than removing feedback.

### 2.13 Focus and accessibility

The web focus ring is `focus-visible:ring-2` + `ring-offset-2` on a white offset —
indigo-500 for most controls, red-500 for danger, slate-500 for the dark secondary
button. Inputs additionally shift their border to indigo-500 and show a 30 %-opacity
indigo ring.

Every screen begins with a "Skip to main content" link that is visually hidden until
focused, then appears as an indigo-600 pill at 16 px from the top-left.

Other invariants worth porting:

- loading regions carry `aria-busy` plus a screen-reader-only `role="status"` label
  (`"Loading…"`) while the visual skeleton is `aria-hidden`;
- error alerts use `role="alert"`, confirmations `role="status"`;
- the active nav item carries `aria-current="page"`;
- required fields render a **visible** red asterisk, not colour-only signalling;
- the loading label is deliberately generic — it never names a record or identity.

---

## 3. Components

### 3.1 Buttons

Base for every variant: inline flex, centred, `gap-2` between icon and label,
`rounded-xl` (12), weight 600, `whitespace-nowrap`, 150 ms transition.

| Variant | Fill | Label | Border | Hover | Focus ring |
| --- | --- | --- | --- | --- | --- |
| **primary** | indigo-600 `#4F39F6` | white | — | indigo-700 + `shadow-elevated` | indigo-500 |
| **secondary** | slate-900 `#0F172B` | white | — | slate-800 + `shadow-elevated` | slate-500 |
| **outline** | white | slate-700 | 1 px slate-300 | bg slate-50, text slate-900 | indigo-500 |
| **ghost** | transparent | slate-600 | — | bg slate-100, text slate-900 | indigo-500 |
| **danger** | red-600 `#E7000B` | white | — | red-700 + `shadow-elevated` | red-500 |

Sizes: `sm` h 36 / px 12 / 14 px text · `md` h **44** / px 16 / 14 px text · `lg` h **48**
/ px 20 / 16 px text. `md` is the default; `lg` is used for the primary submit on auth and
receipt forms.

All solid and outline variants carry `shadow-sm` and press with `translate-y-px`.

**Loading state is built in**: `loading` disables the button, prepends a 16 px spinning
`SpinnerIcon`, and optionally swaps the label (`"Signing in…"`, `"Submitting…"`,
`"Sending…"`). Flutter should replicate this exactly — same spinner size, same label
swap — rather than using a bare `CircularProgressIndicator` replacing the child.

> Note: the `md`/`lg` heights (44/48) already meet the 44 pt touch-target minimum. Keep
> them; do not shrink to `sm` on mobile.

### 3.2 Text fields

| Property | Value |
| --- | --- |
| Height | 44 (`h-11`); textarea min-height 96 (`min-h-24`) |
| Padding | `px-3.5` = 14 horizontal; textarea `py-2.5` = 10 |
| Radius | 12 (`rounded-xl`) |
| Fill | white; disabled → slate-50 |
| Border | 1 px slate-300; focus → indigo-500; error → red-400, focus red-500 |
| Focus ring | 2 px, indigo-500 @ 30 % (error: red-500 @ 30 %) |
| Text | 14 px slate-900; placeholder slate-400 |
| Shadow | `shadow-sm` |

**Layout rule, load-bearing.** Label on top → control directly beneath → hint **or**
error **below the control**. Guidance never sits between label and input. This is what
lets two fields in a 2-column grid keep their inputs on the same row when only one has a
hint. `components/ui/field.tsx` documents it as a CRITICAL LAYOUT RULE.

Vertical rhythm: 8 px label→control, 8 px control→message, 20 px between fields.

Label affixes: required renders ` *` in red-600; optional renders ` (optional)` in
slate-400 weight 400. Hints are 12 px slate-500; errors 14 px weight 500 red-700, wired
via `aria-describedby`, with `aria-invalid` on the control.

### 3.3 Dropdowns

Native `<select>` styled identically to a text field, plus `pr-9` (36 px right padding)
and `appearance-none`, with a 16 px slate-400 chevron absolutely positioned 12 px from
the right edge, vertically centred. First option is a placeholder — `"Select a shop…"`,
`"Select a country…"` — with an empty value.

There is **no** custom dropdown, no combobox, no multi-select, and no searchable picker
anywhere in the product.

> Flutter: a `DropdownButtonFormField` styled with the shared `InputDecoration`, or a
> `CupertinoPicker` in a bottom sheet on iOS. Keep the trailing chevron at 16 px
> slate-400. Keep the placeholder as a real disabled-value entry, not a floating label.

### 3.4 Search fields

**There are none.** A `SearchIcon` exists in `components/ui/icons.tsx` but is not used on
any screen. No list in the product is filterable, sortable, or paginated — the audit log
is a fixed 100 rows, and every other list returns its full set.

> **Product decision required (D-2).** Mobile lists of staff, shops, products, or
> receipts will want search. There is no web precedent to copy and no backend filter
> parameter to call. If search is added, it must be client-side over an
> already-authorized result set, and the field should reuse the text-field spec above
> with a leading 16 px `SearchIcon` in slate-400.

### 3.5 Cards

`cardClasses()` — `rounded-2xl` (16) + 1 px border + white fill + `shadow-card`. Four
variants:

| Variant | Delta |
| --- | --- |
| `standard` | border slate-200 |
| `interactive` | + 150 ms hover: lift 2 px, border → indigo-300, shadow → `shadow-elevated` |
| `highlighted` | border indigo-200 + 1 px indigo-100 ring |
| `muted` | border slate-200, fill slate-50, **no shadow** |

`SectionCard` = a standard card at `p-5 sm:p-6` with a 16 px semibold title, an optional
14 px slate-500 description, an optional right-aligned action, and a body 20 px below.

Specialised cards, all built on the same base:

- **StatCard** — label (14 px slate-500) top-left, 40 px tinted icon disc top-right, then
  the value at 30 px semibold `tabular-nums` (or `"Unavailable"` at 18 px slate-400), then
  a 12 px slate-400 hint. Uses the `interactive` variant.
- **DetailStat** — a compact row: 40 px disc, then a 12 px slate-500 label over a 14 px
  semibold slate-900 value. `p-4`.
- **StatusCard** — 44 px disc + 16 px semibold heading + optional badge + optional
  description; an optional 2-column `<dl>` of label/value details 20 px below; an
  optional right-aligned action that stacks below on mobile. Variants `default` /
  `highlight` (indigo-200 border, indigo-50 @ 40 % fill) / `warning` (amber) / `danger`
  (red). `WarningState` is the warning/danger wrapper.
- **FormStep** — a numbered step card: 44 px indigo-50 disc with the step icon and a
  20 px indigo-600 badge overlapping its top-right corner (white 2 px ring), an
  uppercase `"Step N"` eyebrow, a 16 px title, a description, then the fields 20 px below.
- **InfoPanel** — a 12-radius tinted note (`indigo` / `slate` / `emerald` / `amber`) with
  a leading 16 px icon. Used for non-blocking guidance inside forms.

### 3.6 Status badges

Pill: `rounded-full`, `px-2.5 py-0.5`, 12 px weight 500, 1 px **inset** ring at 20 %
opacity, optional leading 12 px icon.

`components/ui/badge.tsx` holds the **single** backend-enum → label/tone map. Port it
verbatim; the raw enum must never reach the screen.

| Enum | Label | Tone | Icon |
| --- | --- | --- | --- |
| `ACTIVE` | Active | emerald | check |
| `ACCEPTED` | Accepted | emerald | check |
| `APPROVED` | Approved | emerald | check |
| `INVITED` | Invited | amber | clock |
| `PENDING` | Pending | amber | clock |
| `AWAITING` | Awaiting acceptance | amber | clock |
| `SUSPENDED` | Suspended | amber | — |
| `PROCESSING` | Processing | indigo | — |
| `UPLOADED` | Uploaded | blue | — |
| `SUBMITTED` | Submitted | blue | — |
| `EXPIRED` | Expired | slate | — |
| `REVOKED` | Revoked | slate | — |
| `DEACTIVATED` | Deactivated | slate | — |
| `INACTIVE` | Inactive | slate | — |
| `FAILED` | Failed | red | — |
| `REJECTED` | Rejected | red | — |
| *anything else* | **Unknown** | slate | — |

The `mobile-backend-contract.md` note that `list_retailer_staff_invitations().derived_state`
can be `NULL` matters here: a null must fall into the `Unknown` branch, not crash.

### 3.7 Dialogs

**The web app has no modal dialog component.** There is no `<dialog>`, no overlay panel,
no bottom sheet. Every form is a full page or an inline section card.

The only confirmation in the product is a **native `window.confirm()`**, used before
revoking a staff invitation:

> `Revoke the invitation for {recipient}? Their invitation link will stop working
> immediately.`

> Flutter: use a Material `AlertDialog` with `shape: RoundedRectangleBorder(16)`,
> `shadow-modal`, a 16 px semibold slate-900 title, 14 px slate-500 body, and a right-
> aligned ghost "Cancel" + danger "Revoke" pair. Keep the confirmation copy verbatim.
> **Do not invent additional confirmations** — the web deliberately confirms only this
> one destructive act.

`shadow-modal` exists in the token set and is currently applied only to the mobile
navigation drawer. It is the correct elevation for any dialog or sheet Flutter adds.

### 3.8 Snackbars / toasts

**There are none.** All feedback is **inline and in place**:

- form-level errors and successes render as an `Alert` at the top of the form;
- field errors render under their control;
- success alerts additionally carry `sr-animate-fade-in`;
- after a successful action the page revalidates and the form resets.

> Flutter: prefer an inline `Alert` widget matching § 3.9 over `ScaffoldMessenger`. If a
> `SnackBar` is genuinely needed for a transient background result (e.g. a queued receipt
> finally uploading), style it as a `shadow-modal` 12-radius card with the matching tone
> colours — never Material's default dark pill. Never use a snackbar for a validation
> error; those belong beside the field.

### 3.9 Alerts (inline notices)

`rounded-xl` (12), 1 px border, `px-4 py-3`, 14 px text, leading 16 px icon offset 2 px
down, 12 px gap.

| Tone | Border | Fill | Text | Icon | ARIA |
| --- | --- | --- | --- | --- | --- |
| info | blue-200 | blue-50 | blue-900 | info, blue-600 | `role="status"` |
| success | emerald-200 | emerald-50 | emerald-900 | check-circle, emerald-600 | `role="status"` |
| warning | amber-200 | amber-50 | amber-900 | triangle, amber-600 | `role="status"` |
| error | red-200 | red-50 | red-800 | triangle, red-600 | `role="alert"` |

Optional bold title on the first line, body 2 px below. Status is never carried by colour
alone — the icon and the message text both state it.

### 3.10 Progress indicators

1. **Global route progress** — a 2 px bar pinned to the very top of the viewport
   (`z-index 100`), indeterminate, indigo→violet gradient with a soft glow. Driven by
   Next's `useLinkStatus`; cleared on route commit.
2. **Per-item nav spinner** — a 16 px indigo-500 spinner appears at the trailing edge of
   the tapped nav item while its route loads.
3. **Button spinner** — 16 px, inside the button, with an optional label swap.
4. **Skeletons** — see § 3.11.

There is **no** determinate progress bar and **no** circular page spinner anywhere.

> Flutter: a 2 px `LinearProgressIndicator` under the app bar is the closest match for
> (1). Keep the gradient and the indeterminate behaviour, and keep the static-bar
> fallback under reduced motion.

### 3.11 Skeletons

Base: `#E2E8F0` (slate-200) block, `rounded-md` (6), with a 1.4 s left-to-right white-65 %
shimmer. Every route has a `loading.tsx` and reuses these shapes:

| Shape | Composition |
| --- | --- |
| `SkeletonPageHeader` | 28 × 176 title bar + 16 × 288 description; optional 44 × 144 action pill (12-radius) |
| `SkeletonCard` | standard card `p-5` with 16 × 96, 32 × 64, 12 × 128 bars |
| `SkeletonStatGrid` | 4 skeleton cards on the responsive stat grid |
| `SkeletonRows` | card with divided rows: 40 × 40 12-radius avatar + two text bars + a 24 × 64 pill |
| `SkeletonTable` | 16-radius clipped card; slate-50 header strip with N column bars; divided body rows |
| `SkeletonFormSection` | card with a heading pair, then N × (14 × 96 label + 44 full-width 12-radius control) |
| `SkeletonFormActions` | right-aligned 44 × 96 + 44 × 144 pills |

Wrapper `SkeletonScreen` sets `aria-busy="true"`, renders a screen-reader-only
`role="status"` label (default `"Loading…"`), and hides the visual blocks from assistive
tech.

> **Skeletons, not spinners, are the product's loading language.** A Flutter screen that
> shows a centred `CircularProgressIndicator` will not look like SalesReward. Build
> matching skeleton widgets, keep the generic label, and keep the shimmer suppressed
> under reduced motion.

### 3.12 Empty states

A centred column in a **dashed** slate-300 1 px border, 16-radius, white fill, `px-6
py-12`:

56 px tinted icon disc (16-radius) → 24 px gap → 16 px semibold slate-900 title → 6 px →
14 px slate-500 description capped at `max-w-sm` → 24 px → optional action button.

Tones affect only the disc: `slate` (default), `indigo`, `emerald`, `amber`.

The same component serves three meanings, distinguished only by the caller's copy:

| Meaning | Example |
| --- | --- |
| Nothing yet | "No products yet" · "No staff yet" · "No shops yet" · "No receipts yet" |
| Could not load | "Products could not be loaded" · "Owner status unavailable" |
| Nothing for you | "No shops to show" · "No shops assigned yet" |

> The "could not load" copy is deliberately **reason-free** — the underlying failure can
> only come from a database error whose detail must not reach a client. Flutter must
> preserve this. Do not render an exception message, a Postgres code, or a stack trace.

### 3.13 Error states

There is no error *component* distinct from the above. The product uses, in order of
severity:

1. **Field error** — 14 px weight 500 red-700 under the control, `role="alert"`, plus a
   red-400 control border.
2. **Form alert** — a red `Alert` at the top of the form, `role="alert"`.
3. **Empty state, error copy** — for a section that could not load, so the rest of the
   page still renders.
4. **Warning `StatusCard`** — amber or red card for a degraded but non-fatal state
   (e.g. owner status unavailable on the retailer detail page).
5. **Access denied** — a whole-screen surface, § 3.17.

`app/(retailer)/error.tsx` is the only React error boundary in the tree.

### 3.14 List items

Two shapes, both already present in the web because the tables are already responsive.

**Table row** (`md` and up): `px-4 py-3`, 14 px, divided by `divide-slate-100`, whole row
`hover:bg-slate-50`, trailing action right-aligned.

**Mobile card row** (`md:hidden`, `<ul class="space-y-3">`): a 16-radius white card with
1 px slate-200 border, `shadow-card`, `p-4`, containing —

- the primary identifier as a semibold slate-900 link;
- a `<dl>` of 12 px slate-500 labels each paired with a `StatusBadge`;
- a 14 px slate-600 supporting line;
- a full-width or trailing action 16 px below.

`components/ui/profile-summary-card.tsx` and `components/ui/lifecycle-timeline.tsx` are
the two richer list-adjacent surfaces. The timeline is a vertical `<ol>` with 28 px
circular nodes (complete = emerald-600 filled with a check, current = indigo-50 with an
indigo-500 2 px border and a 4 px indigo-100 ring that pulses, upcoming = white with a
slate-300 border, failed = red-500 filled with an ×), joined by a 2 px connector that is
emerald-500 below a complete node and slate-200 otherwise.

### 3.15 Data tables

Structure, identical on all nine tables in the product:

- wrapper: 16-radius, 1 px slate-200 border, white, `shadow-card`, `overflow-hidden`;
- `<thead>`: slate-50 strip, 1 px slate-200 bottom border, 12 px **uppercase**
  `tracking-wide` weight 600 slate-500, `px-4 py-3`;
- `<tbody>`: `divide-y divide-slate-100`, rows `hover:bg-slate-50` with a colour
  transition;
- cells: `px-4 py-3`, 14 px, primary column slate-900, others slate-600;
- last column right-aligned for actions;
- every `<th>` carries `scope="col"`.

Tables in `app/(admin)/retailers`, `app/(admin)/retailers/[relationshipId]` and
`app/(retailer)/retailer/receipts` are already paired with a `md:hidden` card list;
the tables in `products`, `users`, `roles`, `audit-logs`, `retailer/shops`,
`retailer/staff` and `retailer/products` are **not** — they scroll horizontally on a
phone today. See § 4.2.

### 3.16 Page headers

`PageHeader`: optional 12 px uppercase indigo-600 eyebrow → 24 px semibold
`tracking-tight` slate-900 title → optional 14 px slate-500 description capped at
`max-w-2xl`. Actions sit on the right on `sm`+ and stack below on mobile
(`flex-col gap-4 sm:flex-row sm:items-start sm:justify-between`).

`SectionHeader`: 18 px semibold title + optional 14 px slate-500 description + optional
right action, baseline-aligned.

`BackLink`: a leading 16 px chevron-left + 14 px weight 500 slate-500 label, → slate-900
on hover. Copy is always `"Back to X"`.

### 3.17 Access-denied surface

A whole-screen centred `max-w-md` column on slate-50:

brand lockup at 40 px (32 px below) → 16-radius white card `p-6 sm:p-8` → 56 px amber-50
disc with a 1 px inset amber-100 ring holding a 28 px shield in amber-600 → 20 px semibold
title **"Access denied"** → two 14 px slate-500 paragraphs → a full-width sign-out
button.

The copy is fixed and **role-neutral**, and both the Vendor (`/access-denied`) and
Retailer (`/retailer-access-denied`) routes render the identical card — deliberately, so
the two are indistinguishable to a signed-in but unauthorized account:

> **Access denied**
> You are signed in, but this account does not have access to this page.
> Use the navigation available to your account, or sign in with a different account.

> Flutter must not add a reason, a role name, a "contact your administrator" line, or a
> retry button. Sign-out is the only affordance.

### 3.18 Invitation surface

`InvitationShell`: same centred `max-w-md` frame as above, with an optional
three-segment **stage indicator** across the top of the card.

Stage indicator: 24 px circular nodes joined by 2 px rails — done = indigo-600 filled with
a white check, active = indigo-50 with an indigo-300 ring and indigo-700 numeral,
upcoming = slate-100 with a slate-200 ring and slate-400 numeral. An 11.2 px label sits
under each. Labels are deliberately generic (**Invite → Set up → Done**) so no stage
leaks anything about the specific invitation.

Below it: a 48 px tinted disc (indigo / emerald / amber, each with a matching inset ring),
a 20 px title, a 14 px slate-500 description, then left-aligned body content 24 px down.

### 3.19 Navigation elements

**Sidebar** (both portals): fixed, 256 wide, white, 1 px slate-200 right border. A 64 px
header holds the brand lockup with a context caption over a slate-100 bottom border.
Items are `px-3 py-2`, 12-radius, 14 px weight 500, `gap-3`, with a 20 px leading icon.

| State | Treatment |
| --- | --- |
| Default | slate-600 label |
| Hover | slate-100 fill, slate-900 label |
| **Active** | indigo-50 fill, indigo-700 label, **plus** a 4 × 24 indigo-600 rail flush to the left edge with a rounded right end |
| Loading | 16 px indigo-500 spinner at the trailing edge |
| Disabled ("Soon") | slate-400 label, not a link, `title="Coming soon"`, trailing 10 px uppercase slate-500 pill on slate-100 |

Active matching is **exact path equality**, not `startsWith` — otherwise `/retailer`
would light up for every portal route.

Vendor sidebar footer: `"SalesReward · v0.1"` in 12 px weight 500 slate-400 above a
slate-100 top border.

**App bar**: sticky, 64 tall, `bg-white/85` + `backdrop-blur-md`, 1 px slate-200 bottom
border, `z-index 30`. Contents left→right: a 40 px hamburger icon-button (`lg:hidden`),
the portal title at 16 px semibold, then a right cluster of — an identity block (name at
14 px weight 500 over org/role caption at 12 px slate-500, both truncating at 12–16 rem,
hidden below `sm`), a 36 px circular gradient avatar with up to two initials
(indigo-500→violet-600, white 14 px semibold), a 24 × 1 slate-200 separator (hidden below
`sm`), and the sign-out control.

Initials rule (both portals): one word → its first two characters; two or more → first
character of the first and second words; upper-cased; fallback `"VA"` (Vendor) / `"SR"`
(Retailer). `InitialsAvatar` uses first + **last** word instead — a real inconsistency,
noted as **D-3**.

**Mobile drawer**: below `lg`, the sidebar is translated off-canvas
(`-translate-x-full`) and slides in over 200 ms `ease-in-out` with `shadow-modal`,
over a `bg-slate-900/40` + `backdrop-blur-[2px]` scrim. Escape closes it; tapping a nav
item closes it; the scrim is a real focusable button labelled "Close navigation menu".
The content column is offset by `lg:pl-64` on desktop only.

---

## 4. Mobile transformations

The web is already mobile-responsive — breakpoints `sm` 640, `md` 768, `lg` 1024, `xl`
1280. Flutter is building the **`< sm` column**, which mostly already exists. Only the
navigation model genuinely needs a decision.

### 4.1 Sidebar → mobile navigation

Today below `lg` the sidebar is a left drawer behind a hamburger. That is a direct,
zero-risk port (`Scaffold.drawer` + the styling in § 3.19) and it is what "look like the
same product" literally means.

However, the destination counts make a drawer a poor phone experience for two of the four
roles:

| Role | Destinations | Recommendation |
| --- | --- | --- |
| Sales Staff | **1** (Receipts) | **No navigation chrome at all.** A single screen with the app bar. Adding a one-tab bar would be noise. |
| Retailer Manager | **2** (Staff, Products) | **Bottom navigation bar**, 2 items. |
| Retailer Owner | **4** (Overview, Shops, Staff, Products) | **Bottom navigation bar**, 4 items. |
| Vendor Super Admin | **6 active** + 6 "Soon" | **Navigation drawer**, mirroring the web exactly — a bottom bar cannot carry 6 items, and the "Soon" placeholders are meaningful to this internal audience. |

Bottom-bar styling to keep it on-brand: white fill, 1 px slate-200 **top** border,
`shadow-card` inverted (or none), 20 px icons, 12 px weight 500 labels, selected =
indigo-600 icon + label, unselected = slate-500. **Keep an explicit selected indicator
beyond colour** — the web's indigo rail becomes a 3 px indigo-600 bar above the selected
tab, or a `NavigationBar` pill indicator in indigo-50. Do not rely on tint alone.

> **Product decision required (D-4):** drawer everywhere (maximum visual fidelity) vs.
> per-role bottom bar (better phone ergonomics). The recommendation above is the
> per-role split; it changes navigation *mechanics* only, and every colour, icon, and
> label stays identical.

Regardless of choice: **navigation is presentation, never protection.** The web says so
in three separate source comments. Flutter must re-check access on every screen and let
the backend refuse; hiding a destination removes an accident, never a capability.

### 4.2 Tables → mobile cards

The pattern already exists and should be applied uniformly. `app/(admin)/retailers/page.tsx`
is the reference:

```
<div class="hidden … md:block">   <table>…</table>   </div>
<ul   class="space-y-3 md:hidden"> <li><card/></li>… </ul>
```

Flutter renders **only the card branch**. Per § 3.14: 16-radius white card, 1 px
slate-200, `shadow-card`, `p-4`, 12 px vertical gap between cards, primary identifier as
a semibold slate-900 tappable line, `StatusBadge`s paired with 12 px slate-500 labels, a
supporting slate-600 line, then the action.

Seven tables have no card branch yet and need one designed for Flutter — reuse the same
shape:

| Screen | Table columns → card |
| --- | --- |
| Vendor products | name (title) · code + barcode (supporting) · status badge · updated-at caption |
| Vendor users | name (title) · email (supporting) · role + status badges |
| Vendor roles | role name (title) · description (supporting) · permission count |
| Vendor audit logs | action (title) · actor + target (supporting) · timestamp caption |
| Retailer shops | shop name (title) · code + city/country (supporting) · status badge |
| Retailer staff | member name (title) · email (supporting) · role + status badges |
| Retailer products | product name (title) · code + barcode (supporting) · status badge |

Rules: **never** horizontally scroll a table on a phone, and never drop a column
silently — every column becomes a labelled line, a badge, or a caption, or moves to a
detail screen.

### 4.3 Multi-column forms → vertical forms

Web forms use `grid grid-cols-1 gap-4 sm:grid-cols-2` — they are **already single-column
below 640 px**. Flutter simply always renders the `grid-cols-1` case. Nothing is
redesigned; the `FormStep` cards, the 20 px inter-field rhythm, and the label→control→
message order all carry over unchanged.

Form actions: web is a right-aligned `Cancel` (outline) + primary pair. On mobile, make
the primary **full-width** and place `Cancel` beneath it (or as a `BackLink`-style text
button above), matching the receipt form's `className="w-full sm:w-auto"` precedent.

The one form that is genuinely mobile-first already — receipt submission — should be
ported closely: a large dashed **tap-to-upload** target (16-radius, 2 px dashed
slate-300, slate-50 fill, `px-6 py-8`, a 48 px indigo-50 disc with a 24 px upload icon,
"Tap to upload a receipt", then a 12 px constraint line). When a file is chosen it
becomes a filled indigo-200 / indigo-50-at-60 % row showing a 44 px white disc, the
truncated file name (`aria-live="polite"`), the formatted size, a "Replace" text button
and a 32 px × close button.

> Flutter should offer **camera capture and gallery pick** from that target — the web's
> `<input type="file">` cannot, and this is the single biggest genuine mobile
> improvement available. Downscale before upload: the bucket caps at 10 MiB and accepts
> only `image/jpeg|png|webp`. Per `mobile-backend-contract.md`, the SHA-256 must be
> computed over the **exact bytes uploaded** — hash after any re-encoding, never before.

### 4.4 Desktop dialogs → mobile

There are no desktop dialogs (§ 3.7), so nothing to transform. Introduce dialogs only
where the web uses `window.confirm` — currently one place. Style per § 3.7. For anything
larger (a picker, a filter), prefer a bottom sheet with a 16-radius top, a 32 × 4
slate-300 grab handle, `shadow-modal`, and the same `bg-slate-900/40` scrim the drawer
uses.

### 4.5 Large dashboard cards

`grid-cols-1 sm:grid-cols-2 xl:grid-cols-4` → **one column, full width** on a phone.
Keep `StatCard` intact: 30 px `tabular-nums` value, 40 px disc, 12 px hint, 16 px gaps.
Do not shrink the value or drop the disc — the metric size is a deliberate part of the
look, and 4 stacked cards is ~4 × 132 px, which is acceptable above the fold on a modern
phone.

The Vendor dashboard's 3 "Quick action" shortcut cards (`sm:grid-cols-3`) likewise stack
to one column and keep their 40 px disc + trailing arrow-up-right glyph.

`StatusCard`'s detail `<dl>` is `grid-cols-1 sm:grid-cols-2` — one column on mobile,
already correct.

### 4.6 Recommended navigation summary

| Element | Mobile form |
| --- | --- |
| Vendor sidebar | `Drawer`, styled exactly as § 3.19 |
| Retailer Owner / Manager nav | `NavigationBar` (bottom), 2–4 items |
| Sales Staff | none — single screen |
| App bar | `AppBar`, 64 tall, white @ 85 % + blur, 1 px slate-200 bottom border, elevation 0 |
| Back navigation | `BackLink` becomes the app-bar leading chevron; keep the "Back to X" label as the app-bar title on detail screens where the web shows it |
| Route progress | 2 px indeterminate gradient bar under the app bar |
| Tabs | **not used anywhere in the web** — do not introduce them |

---

## 5. Screen-by-screen design mapping

Route → Flutter screen. Copy in quotes is verbatim from the source and should not be
reworded.

### 5.1 Login — `app/login/page.tsx`

Web is a 2-column split: a gradient marketing panel (`lg` and up) beside the form. On
mobile the panel is **already hidden** and the form is the whole page on slate-50.

Flutter builds the mobile column: brand lockup at 40 px, 32 px gap, then a 16-radius white
card `p-6` containing "**Welcome back**" (24 px semibold) + "Sign in to your SalesReward
account to continue." (14 px slate-500), then the form — Email address, Password, and a
full-width `lg` primary "Sign in" / "Signing in…". Footer: "Secure sign-in · SalesReward"
in 12 px slate-400, centred, 32 px below.

The `AuthBrandPanel` (indigo-600→indigo-700→violet-800 gradient, faded grid overlay, three
blurred ambient glows, the drawn sales-line artwork, the headline "The retail incentive
platform that turns verified sales into rewards.", three benefit rows, and a "Secure
multi-tenant platform" trust pill) is **desktop-only and should not be ported to a phone**.
It is a reasonable tablet-landscape asset if that form factor is in scope.

**Invariants:** the page is *role-neutral* — nothing names a role, because the page
genuinely cannot know who is signing in. There is no sign-up, no forgot-password, no
social login, and no demo credentials. Error copy must stay generic — never reveal
whether an address exists. Where the user lands is resolved **on the server**; Flutter
must call the landing resolution and follow it, never infer a destination from what the
user typed.

### 5.2 Vendor dashboard — `app/(admin)/page.tsx`

`PageHeader` eyebrow "Vendor Admin", title "Dashboard", description "Managing **{org}**.
Overview of your organization's members, access control, and recorded activity."

Then a 4-up stat grid → 1 column on mobile:

| Label | Hint | Tone |
| --- | --- | --- |
| Active Members | "Active memberships in this organization" | indigo |
| Active Roles | "Roles available in the role catalogue" | emerald |
| Permissions | "Permissions defined across all modules" | amber |
| Audit Events | "Recorded admin actions for this organization" | slate |

Then "Quick actions" (18 px semibold) over three shortcut cards → 1 column: Manage
Retailers, Product catalog, Audit logs.

A `null` count renders "Unavailable" (18 px slate-400), **never `0`**.

### 5.3 Retailer list — `app/(admin)/retailers/page.tsx`

`PageHeader` title "Retailers" + a primary "Onboard Retailer" action with a leading plus
icon. Body is the table/card pair — **the card branch already exists**, use it as the
reference implementation (§ 4.2). Each card: retailer name as a semibold tappable link,
then labelled `StatusBadge`s for "Retailer" and "Relationship", a shop-count line, and a
trailing "View" outline button with a chevron-right.

Empty states: "No Retailers yet" with an onboard action; and a reason-free
could-not-load variant.

### 5.4 Retailer detail — `app/(admin)/retailers/[relationshipId]/page.tsx`

`BackLink` "Back to Retailers" → `PageHeader` → a 4-up `DetailStat` grid (→ 1 column) →
an owner-status `StatusCard` (or a `WarningState` / "Owner status unavailable" empty
state) → a `ProfileSummaryCard` → a `LifecycleTimeline` of the invitation lifecycle → the
shops table/card pair (card branch exists) with an "Add shop" action and a "No shops yet"
empty state.

This is the densest screen in the product. On a phone it becomes one long scroll; keep
the section order exactly as above so the two clients stay comparable.

### 5.5 Invite Retailer Owner — `app/(admin)/retailers/[relationshipId]/owner/invite/`

`BackLink` → `PageHeader` → numbered `FormStep` cards → a full-width primary submit. Two
distinct forms share the route: a new-account invite and an existing-account send. Field
errors render under their controls; the form-level result renders as an `Alert` above.

Static access context and a security note are rendered as an `InfoPanel`. Per the
source tests, **no token, hash, or secret crosses into the client** — only a routing id.

### 5.6 Products (Vendor) — `app/(admin)/products/`

`PageHeader` "Products" → `SectionHeader` "Catalog" → a 7-column table (needs a card
branch per § 4.2) → a `SectionCard` "Add a product" holding the create form.
`app/(admin)/products/[productId]/` is the detail screen with the retailer-assignment
table and assign/withdraw controls.

Per `mobile-feature-matrix.md`, duplicate code-vs-barcode errors are currently
discriminated by an **English message substring**. Flutter must not re-implement that
matching; surface the server's message and wait for the SQLSTATE fix (contract fix #3).

### 5.7 Retailer portal overview — `app/(retailer)/retailer/page.tsx`

`PageHeader` eyebrow "Retailer Owner Portal", title = the retailer's name, description
"A read-only view of your organization and its shops on SalesReward." Then a 4-up
`DetailStat` grid → 1 column.

Owner-only. A Manager gets zero rows from the backing RPC — render the standard empty
state, **not** an error.

### 5.8 Shops (Retailer) — `app/(retailer)/retailer/shops/page.tsx`

`PageHeader` "Shops" → a 5-column table (needs a card branch) → "No shops to show" empty
state → a warning `Alert` titled "Shops could not be loaded" on failure.

Blocked for mobile navigation: `list_retailer_owner_portal_shops()` **returns no
`shop_id`**, so a Flutter list cannot key its rows or open a detail screen (contract fix
#1). Until then, render the list as non-tappable.

### 5.9 Staff — `app/(retailer)/retailer/staff/page.tsx`

The most role-conditional screen in the product. Three independently-gated sections:

1. **Roster** — `SectionHeader` + table (needs a card branch) or "No staff yet".
2. **Invitations** — shown when `showsInvitationSection(status)`; table with per-row
   Resend (outline, `sm`) and Revoke (danger, `sm`, native confirm) controls, or "No
   invitations yet".
3. **Invite staff** — shown when `showsInviteSection(status)`; the form itself renders
   only when `showsInviteForm(status)` (i.e. status is exactly `ok`). Description: "Send
   an invitation to join your Retailer. They will accept it by signing in with the email
   address you enter."

The show/hide predicates live in `lib/staff/portal-access-decision.ts` and are driven by
what the **backend** returned, not by a locally-known role. Port that shape:
`denied` → hide the section; `unavailable` → show the section with a warning; `ok` →
show it fully. Never gate on a client-side role string.

### 5.10 Products (Retailer) — `app/(retailer)/retailer/products/page.tsx`

Read-only assigned-products table (needs a card branch). No create, edit, or status
control. Available to both Owner and Manager.

### 5.11 Receipts — `app/(retailer)/retailer/receipts/page.tsx`

`PageHeader` "Receipts" → `SectionCard` "Submit a receipt" (shop `<select>` + the
tap-to-upload target + a full-width `lg` primary "Submit receipt" / "Submitting…") →
`SectionCard` "Your submissions" with a 5-column history table (card branch exists) or a
"No receipts yet" empty state. When the user has no assigned shops, the submit card is
replaced by "No shops assigned yet".

Never rendered, and must stay that way in Flutter: the storage bucket, the object path,
the file hash, any profile/membership/organization id, any failure code, and any other
person's data.

This is the **Sales Staff mobile MVP screen** — the highest-value port. It is also
blocked on the `submit-receipt` Edge Function (storage has zero policies today; upload
requires the service key, which must never reach a device).

### 5.12 Invitations — `app/invitations/*`

Six routes on the shared `InvitationShell`: `accept` (route handler), `complete`,
`existing`, `existing/enter`, `staff`, `staff/enter`, `success`, `error`. Each is the
centred `max-w-md` card with the three-step generic indicator (**Invite → Set up →
Done**), a tinted disc, a title, a description, and either a form or a status message.

Copy is deliberately generic at every stage so nothing about the specific invitation
leaks. Flutter needs deep-link / app-link handling for the token URLs, and must
**SHA-256 the raw token itself and persist only the hash** — the raw token is never
stored.

### 5.13 Profile

**There is no profile screen.** No route, no component, no RPC returns an editable
profile. The only identity surface is the app-bar lockup: the signed-in name (Vendor) or
retailer name (Retailer), a role/organization caption, initials avatar, and sign-out.

> **Product decision required (D-5).** A mobile app is normally expected to have an
> account screen. Building one requires a new backend read (nothing today returns a
> user's own profile to them) and a decision about whether anything on it is editable.
> Until then, the honest port is an **account sheet** reachable from the avatar,
> containing exactly what the app bar already shows plus sign-out — inventing nothing.

### 5.14 Access denied — `/access-denied`, `/retailer-access-denied`

Per § 3.17, verbatim, for both. Sign-out is the only action. Do not add a reason, a
role, a support link, or a retry.

---

## 6. Unresolved product decisions

These are design decisions this document cannot make on the project's behalf. None
blocks starting the port; each will change specific pixels or specific mechanics.

| # | Decision | Why it exists | Recommendation |
| --- | --- | --- | --- |
| **D-1** | Which indigo? The brand mark uses `#4F46E5`→`#7C3AED` (hard-coded, Tailwind v3-era) while every `indigo-600` utility renders `#4F39F6` (Tailwind v4 OKLCH). | Tailwind v4 changed the default palette; the SVG literals were never updated. | Reproduce **exactly what ships today**: v4 hexes for UI, the literals for the mark. Then align the two in a follow-up on **both** platforms at once. |
| **D-2** | Should mobile lists have search/filter? | No web precedent, no icon in use, no backend filter parameter. | Add client-side search only, over an already-authorized result set, once a list actually gets long. Do not add server filtering without a contract change. |
| **D-3** | Initials: first-two-words (shells) or first-and-last-word (`InitialsAvatar`)? | Two rules exist in the web today for the same visual element. | Pick first + last (`InitialsAvatar`) and fix the web shells; it handles middle names better. |
| **D-4** | Drawer everywhere vs. per-role bottom navigation? | Sales Staff has 1 destination, Vendor has 12. One model cannot serve both well. | Drawer for Vendor; bottom bar for Retailer Owner (4) and Manager (2); no chrome for Sales Staff (1). |
| **D-5** | Is there a profile / account screen? | The web has none, and no RPC returns a user's own profile. | Ship an account **sheet** with only what the app bar already knows, plus sign-out. Anything more needs a new backend read. |
| **D-6** | Tablet / landscape support? | The web's 2-column login panel and 4-up grids are real designs that a phone-only port discards. | Out of scope for the MVP; the responsive rules above already describe the ≥ 640 and ≥ 1024 layouts if it comes into scope. |

Backend-side open questions (Q1–Q8) are tracked in `mobile-backend-contract.md` § 7 and
`mobile-feature-matrix.md`, not here.

---

## 7. Porting checklist

- [ ] Light theme only; `ThemeMode.light` pinned. No dark `ColorScheme`.
- [ ] Geist bundled as the sans family.
- [ ] Brand mark reproduced as a widget from the § 1 geometry — not a raster.
- [ ] Three radii internalised: **12** controls, **16** surfaces, **full** pills.
- [ ] The three custom slate-tinted shadows, not Material elevation.
- [ ] The 38-icon set ported at stroke width 1.75 with round caps — no Material Icons.
- [ ] `StatusBadge` enum map ported verbatim, including the `Unknown` fallback and the
      `NULL` `derived_state` case.
- [ ] Skeletons, not spinners, for every route load.
- [ ] Inline `Alert`s, not snackbars, for every form result.
- [ ] Empty-state "could not load" copy stays reason-free — no exception text ever.
- [ ] Access-denied copy verbatim, role-neutral, sign-out only.
- [ ] Every table has a card branch; nothing scrolls horizontally.
- [ ] Reduced motion honoured, including a static progress bar rather than none.
- [ ] Navigation treated as presentation; every screen re-checks access server-side.
