---
name: td-ui-design
description: Design rules for the Nexus frontend's TotalDealer look — tokens, components, and what to avoid so it reads as a product, not an AI template. Use before changing any UI in frontend/ (new screen, component, restyle, dark-mode fix) or when reviewing a UI diff.
---

# TotalDealer UI design rules

The frontend matches totaldealer.com.mx: orange accent, navy text, light surfaces, rounded corners. It must look like a maintained business tool, not a generated landing page. Read `frontend/app/globals.css` first — every value below lives there as a token.

## Tokens (never hardcode hex in components)

| Use | Token | Notes |
|---|---|---|
| Fill behind white text (primary button, user bubble) | `--accent` `#D93D12` | 4.54:1 with white. The brand orange `#F04A1A` is only 3.68:1 — never put white text on it. |
| Orange **text** on a surface | `--accent-fg` | `#C2410C` light, `#FF7A45` dark |
| Decoration without text (icons, underline, focus ring) | `--accent-bright` `#F04A1A` | |
| Selected / hover tint | `--accent-tint`, `--accent-border` | |
| Text | `--text-primary` (navy) › `--text-secondary` › `--text-muted` › `--text-faint` | `--text-faint` is for placeholders/timestamps only (fails AA for body text) |
| Surfaces | `--bg-page`, `--bg-surface`, `--bg-muted`, `--border-default`, `--border-strong` | |
| Errors | `--danger`, `--danger-fg`, `--danger-bg` | Rose, deliberately not red-orange, so it can't read as brand |
| Radius | `--radius-sm` 8 · `--radius` 12 (buttons, inputs) · `--radius-lg` 18 (cards) · `--radius-xl` 22 (dialogs) · `--radius-pill` | Keep these proportions |

Dark mode is **graphite** (`#0F1113` page / `#181B1F` surface), not navy or blue. Every token is redefined under `html.dark`; if a new token is added, add its dark value in the same change.

Typography: Inter (next/font). Body 14–15px weight 400. Headings 700 with slight negative tracking (`-0.02em`). Uppercase only for small labels (`.nqt-label`, 10–11px) — never for buttons, titles, or sentences.

## Use the kit, not inline styles

- Buttons: `nqt-btn nqt-btn--{sm|md} nqt-btn--{primary|ghost|danger}`; icon-only: `IconButton` / `.nqt-iconbtn`.
- Inputs: `.nqt-input`. Cards: `.nqt-card` or the `Card` component. Dialogs: `Modal` / `ConfirmDialog`. Tags: `Badge`.
- Logo: `BrandLogo` (it swaps color/white wordmark by theme with CSS). TotalDealer logo only — no other brand marks.
- Hover/focus belong in CSS classes, not `onMouseEnter` handlers.

## What makes it look "AI-generated" — do not add

- **No frosted glass**: no `backdrop-filter: blur` on headers, overlays or panels. Headers are solid `--bg-header` with a 1px bottom border.
- **No glows**: no colored `box-shadow` on buttons, no pulsing/glowing attention animations.
- **No decorative gradients**: no radial "blob" backgrounds, no gradient text, no gradient bars. Flat `--bg-page`.
- **No floating on hover**: no `translateY` lifts or scale-ups on cards/buttons. Hover = border to `--border-strong` and/or background to `--bg-muted`.
- **No entrance choreography**: no staggered `animationDelay` on lists, no slide-ups on page load. A 150–200ms fade for newly arriving chat messages is the ceiling.
- **Shadows stay small**: surfaces are defined by their 1px border; `--shadow`/`--shadow-sm` only hint at depth. `--shadow-lg` is only for layers that float over the page (modal, side panel, toast).
- **No eyebrow kickers**: don't stack an orange uppercase label over every heading. The "navy headline with one orange word" pattern is used once (chat welcome) — don't repeat it on other screens.
- **Focus rings are crisp**: 1–2px solid ring in `--input-focus`/`--accent-bright`, not a blurry tinted halo.
- **Copy is plain**: labels say what the thing does ("Iniciar sesión", "Nueva conversación"), not marketing lines. All user-facing text is Spanish.

## Accessibility checks

- Check contrast for any new color pair (≥ 4.5:1 body text, ≥ 3:1 large text and UI glyphs). A quick check:
  `node -e 'const L=h=>{const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]};const[a,b]=process.argv.slice(1);console.log(((Math.max(L(a),L(b))+.05)/(Math.min(L(a),L(b))+.05)).toFixed(2))' '#FFFFFF' '#D93D12'`
- Icon-only buttons need `aria-label`. Touch targets stay ≥ 40px on coarse pointers (the kit handles this).
- `prefers-reduced-motion` is honored globally in `globals.css` — don't override it.

## Verify

1. `cd frontend && npm run build` (the only reliable type-check).
2. Rebuild/restart the frontend (hot-reload is broken on Windows bind mounts — clear `/app/.next` and restart the container).
3. Look at the change in light, dark, and 375px width. No horizontal scroll at 375px.
4. `npx playwright test` — some specs select by visible text; if a label changes, update the spec in the same change.
