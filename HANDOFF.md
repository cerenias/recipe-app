# Receptfinnaren — Handoff

## What the app is

Single-file mobile recipe app (`index.html`) hosted on GitHub Pages.  
Backend is a Cloudflare Worker (`worker.js`) that proxies Spoonacular, scrapes recipe URLs, handles Willys availability checks, and manages user auth + cloud sync via Cloudflare KV.

**Live URL:** `erenias.github.io/recipe-app`  
**Worker URL:** stored per-device in Settings (user sets it manually)

---

## What was built in this session

### Spoonacular opt-in
Spoonacular was auto-triggering on every search, burning the 150 req/day free quota. Changed to a manual **"🥄 Sök på Spoonacular"** button that appears at the top of search results. Filtering no longer auto-fires Spoonacular either.

### Måltid (meal type) filter
New filter added to both the **Recept** tab and **Lagade** tab:
- Options: Middag/Lunch · Frukost · Efterrätt · Drink · Mellanmål
- **Decision:** Middag and Lunch were merged into one "Middag/Lunch" option (val = `'middag'`). Recipes tagged `mealType: 'lunch'` are matched by the helper `mealTypeMatches()` so no data migration was needed.
- TheMealDB auto-maps: Breakfast → frukost, Dessert → efterrätt, Starter → mellanmål, everything else → middag.
- Added to the add/edit recipe form as a single-select chip group.

### Lagade tab improvements
- Filter bar split into two scrollable rows (matching Recept tab layout).
- Spacing/margin matched to Recept tab.
- **"🗑 Ta bort från Lagade"** button added at the bottom of the recipe panel (below the rating Save button) — clears `cooked`, `cookedAt`, `rating`, and `comment`.

### Förb. (prep time) filter removed
Removed from the browse filter bar — too few recipes have prep time data for it to be useful. The prep time field in the add/edit form was kept so existing data is preserved.

### Ingredient photo scanner ("Vad kan jag laga?")
Major new feature. **Worker:** new `?action=identify` POST route sends a base64-resized image to `claude-3-5-haiku-20241022` and returns a JSON array of English ingredient names.

**Frontend flow:**
1. Dashed "📷 Vad kan jag laga?" button below filter chips in browse tab
2. Scanner panel slides up — capture state shows camera button + manual text entry
3. After photo: Claude identifies ingredients, shown as removable pills; user can add/remove more manually
4. "Hitta recept" runs `scoreRecipeMatch()` against all TheMealDB + saved + Spoonacular results
5. Results ranked by match % with green/yellow/grey badge and a "missing ingredients" list

**Scoring:** Pantry staples (salt, pepper, oil, mjöl, etc.) excluded via `PANTRY_SKIP` set. Matching uses substring both ways + Swedish↔English via `translateIngredient`.

**Results filters:** Two scrollable chip rows — Måltid filter + Källa filter (TheMealDB / Spoonacular / Mina recept).

**Spoonacular in scanner:** "Sök fler på Spoonacular" button uses Spoonacular's `/findByIngredients` endpoint (not `complexSearch`) — sends the actual ingredient list, gets back recipes ranked by ingredient usage. New worker route `?spc_ing=`. Results merged into the scanner pool and also registered in `spoonacularResults` so `openRecipe()` can find them.

**Decision:** Image is resized to 800px max on device before upload (canvas resize) to keep payload small. Media type preserved from file input.

### Share recipe (Web Share API + deep link)
**"↗ Dela recept"** button added to every recipe panel.

- **Mobile:** opens native share sheet (WhatsApp, Messages, etc.) with formatted recipe text + a deep link URL
- **Desktop:** copies link to clipboard
- **Link format:** `erenias.github.io/recipe-app/#share=BASE64` — full recipe encoded in the URL fragment, no backend needed
- **Receiving:** app detects `#share=` on load, decodes recipe into `pendingSharedRecipe`, opens the recipe panel automatically after boot. "💾 Spara recept" button saves it to the collection.
- Shared preview uses id `'_shared_preview'` — not persisted until explicitly saved.

### Ingredient translation (English mode)
`translateIngredient()` previously only translated English → Swedish. Now also translates Swedish → English by building `INGREDIENT_EN` as an automatic reverse map of `INGREDIENT_SV` at startup (longest English key wins per Swedish value). Shopping list, recipe panel ingredients, and scanner matching all use the same function.

### Tab persistence on refresh
`showView()` saves the active tab to `localStorage`. On page load, `restoreTab()` restores it. The "add recipe" tab is excluded (would be confusing to land on a blank form).

---

## Key architectural decisions

| Decision | Rationale |
|---|---|
| Single `index.html` | Keeps deployment trivial (GitHub Pages, no build step) |
| Cloudflare Worker as proxy | Hides API keys, handles CORS, costs nothing for personal use |
| Cloudflare KV for sync | Entire recipe collection stored as one blob per user (`data:{username}`). Simple, free tier covers personal use. Would need a real DB for 100+ users. |
| Auth: username + PIN only | No email required — low friction for friends sharing the app. SHA-256 hash of `username:pin`, 30-day session tokens in KV. |
| Spoonacular opt-in | 150 req/day free limit. Auto-firing on every search was burning quota when multiple friends use the app. |
| `findByIngredients` for scanner | `complexSearch` with ingredients as text query returns irrelevant results. Spoonacular's dedicated endpoint returns recipes ranked by actual ingredient match. |
| Claude Haiku for vision | ~$0.0005/photo, fast, accurate. Image resized to 800px on device before upload. |
| Share link = base64 in URL fragment | No backend needed, works offline, no quota. Links are ~500–2000 chars which is fine for WhatsApp/Messages. |
| `mealTypeMatches()` helper | Centralises the middag/lunch merge logic so it works identically in all three filter contexts (browse, lagade, scanner). |

---

## Cloudflare Worker — required bindings

| Type | Variable name | Purpose |
|---|---|---|
| Secret | `SPOONACULAR_KEY` | Spoonacular API |
| Secret | `ANTHROPIC_API_KEY` | Claude Haiku vision (ingredient scanner) |
| KV Namespace | `RECIPE_KV` | User accounts, sessions, recipe sync |

---

## localStorage keys

| Key | Contents |
|---|---|
| `receptfinnaren_v1` | Saved recipes array |
| `receptfinnaren_shopping_v1` | Shopping list |
| `receptfinnaren_lang` | `'sv'` or `'en'` |
| `receptfinnaren_auth` | `{ username, token }` when logged in |
| `workerUrl` | Cloudflare Worker URL |
| `receptfinnaren_tab` | Last active tab (restored on refresh) |

---

## Possible next steps

- **Share codes via KV** (Option 3 from the share discussion) — short codes like `KYCKLING-47` instead of long base64 URLs, for users who want to share many recipes in a group chat.
- **Spoonacular `findByIngredients` for regular search** — the scanner uses it correctly; the regular Spoonacular search still uses `complexSearch`. Could offer both modes.
- **More meal types** — user mentioned middag/lunch merge; could also discuss whether Mellanmål is needed or if Förrätt should be added.
- **Scaling** — if more than ~20-30 friends use the app, KV blob-per-user starts becoming inefficient on saves (whole collection rewritten each time). Consider chunking or a D1 database.
- **Offline support** — a service worker could cache `index.html` and TheMealDB results so the app works without network.
- **Export/import** — already exists (JSON export button in Settings), but could be surfaced more prominently.
