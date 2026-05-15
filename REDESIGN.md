# cc-web Redesign Initiative — Final Report

**Period**: 2026-05-15 (single session, 27 rounds)
**Range**: HEAD `2f841a7` → `a0bb660` (17 commits)
**Method**: Self-driving loop — each round spawns a fresh read-only analyzer (independent ROI assessment); main thread implements + deploys + commits. Termination triggered on 3 consecutive `NO_REDESIGN_OPTIMIZATION` rounds.
**Outcome**: 22 ships + 1 hotfix; pool exhausted at R25-R27.

---

## 1 — What shipped

### 1.1 Custom components (replaced native browser primitives)

| ID  | Component                | Replaces            | Why                                              |
|-----|--------------------------|---------------------|--------------------------------------------------|
| C1  | `.mode-pill` + menu      | `<select>`          | Native select can't be themed across OS          |
| C2  | `appAlert/Confirm/Prompt`| `window.alert/...`  | Native dialogs ignore design system              |
| C3  | Custom switch            | `<input type=checkbox>` | inconsistent across Safari/iOS/Android       |
| C4  | Custom radio             | `<input type=radio>`    | same — `appearance: none` + `::after` thumb  |

### 1.2 Token systems (design language scaffolding)

| Axis           | Tokens                                                                                | Sites                |
|----------------|---------------------------------------------------------------------------------------|----------------------|
| Typography     | `--fs-micro..display` (9), `--lh-tight..flat` (5), `--fw-normal..black` (5), `--ls-tight..widest` (5) | 151 fs + 50 lh + 74 fw + 28 ls = 303 var refs |
| Spacing        | `--space-0..10` (11) + 5 semantic clusters (`--gap-*`, `--pad-*`)                     | 254 var refs (was 267 literals) |
| Radius         | `--radius-xs..3xl` + `--radius-pill` + `--radius-circle` (9)                          | 116 var refs (was 125 literals) |
| Elevation      | `--shadow-1..5` + `--shadow-focus` + `--shadow-inset-hi`, theme `--shadow-tint`        | 22 var refs                    |
| Color          | `--accent` 4-slot + `--success/-warning/-danger/-info` × 4-slot + `--neutral-50..900` (9) + `--hook` | 91 substitutions (incl. 47 stripped fallbacks) |
| Motion         | `--ease-standard/-emphasized/-spring/-soft` (4) + `--dur-instant/-fast/-base/-emphasis/-slow` (5) | 94 substitutions |
| Bubble (V6)    | `--bubble-pad-user/-asst/-sys` + `--bubble-radius-user/-asst`                         | 3-tier message hierarchy        |
| Tool-card (V7) | reuses spacing + bubble tokens                                                        | 4-tier sub-card hierarchy       |

### 1.3 Mobile / touch hardening (R14)

- iOS auto-zoom guard: `font-size: 16px` on all inputs at `pointer:coarse`
- Touch targets ≥ 44×44 (Apple HIG) — 480px breakpoint no longer shrinks `.send-btn`/`.abort-btn` below threshold
- `visualViewport` API: `--kb-inset` injected into `.input-area` `padding-bottom` so soft keyboard never occludes input
- 380px ultra-narrow safety net (chat-cwd hidden, mode-pill text → dot only)
- 480px modal becomes bottom-sheet (slide-up + rounded top corners)
- Landscape `max-height:480px` collapses welcome icon + 44px header
- `touch-action: manipulation` kills 300ms click delay on tap buttons

### 1.4 Accessibility (WCAG)

| Round | SC                                              | Level             | Result                |
|-------|-------------------------------------------------|-------------------|-----------------------|
| R18   | 2.4.7 Focus Visible                             | AA                | 4 → 30 `:focus-visible` declarations using `--shadow-focus` |
| R19   | 2.1.1 Keyboard                                  | A                 | session-item became Tab-reachable; skip-link added; 8 icon-only buttons gained aria-label |
| R20   | 1.4.3 Contrast Minimum                          | AA                | `--text-muted` darkened across 3 themes to clear 4.5:1 (washi 4.57 / coolvibe 4.74 / editorial 5.20) |
| R21   | 4.1.3 Status Messages                           | AA                | `#chat-announce` polite live region announces "回复已完成" once per turn |
| R23   | 3.3.5 Help                                      | AAA (optional)    | `?` key opens persistent kbd-shortcuts dialog (8 shortcuts catalogued) |

### 1.5 PWA (R22 + R24)

- `manifest.webmanifest` (name / start_url / display=standalone / theme_color #c0553a / 512px icon)
- `theme-color` meta in `<head>`
- `.webmanifest` MIME registered (`application/manifest+json`)
- R24 hotfix: icon `purpose: "any maskable"` → `"any"` (favicon-512 had no safe-area; was being adaptive-cropped on Android)

---

## 2 — What was rejected (and why)

| Candidate                                | Reason                                                                |
|------------------------------------------|-----------------------------------------------------------------------|
| `prefers-color-scheme: dark`             | 3 manual themes + auto-dark conflicts with picker semantics; would also need full re-contrast audit                |
| Tablet 1024px breakpoint                 | No break evidence; 768→desktop transition is visually intact          |
| `sw.js` offline cache                    | Anti-value for a CLI-subprocess wrapper (no backend = no chat possible) |
| Maskable icon purpose-built              | Out of scope (needs new binary asset)                                 |
| WCAG 1.4.6 / 1.4.8 / 2.4.8 (AAA long tail) | Would break V4 palette / V6 bubble hierarchy / N/A for chat UI         |
| Server.js / scripts cleanup              | Out of redesign scope; would be architecture refactor or doc-sync     |

---

## 3 — Numbers

- 17 commits between `2f841a7` and `a0bb660`
- 22 redesign features + 1 regression hotfix
- ~2500 lines net additions (mostly CSS expansion + a11y attributes)
- 0 tokens removed once added (no design backslide)
- 0 BEAUTY motion regressions across 27 rounds
- 0 functional regressions (WebSocket, auth, sessions, attachments untouched)
- All R1-R24 deployed live to https://cc.9962510.xyz; service uptime preserved

---

## 4 — Termination rationale

R25 (frontend), R26 (backend/scripts/docs), R27 (cross-domain final pass) — three independent read-only analyzers each returned `NO_REDESIGN_OPTIMIZATION` after sampled grep + Read across the full codebase. Every remaining candidate either:

- breaks an existing token system (dark scheme vs. R20),
- belongs to a different work category (doc sync, architecture refactor),
- requires resources outside this loop (binary assets, design source for new logos),
- or is anti-value for the product class (offline cache for a thin CLI wrapper).

Continuing past 3 consecutive NO_OPTs would have entered negative ROI territory: refactor risk exceeds visual/UX gain.

The redesign initiative is closed. The token systems and a11y baseline established here are stable foundations for incremental future work.
