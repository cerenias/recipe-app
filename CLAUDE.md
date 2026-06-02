# Receptfinnaren — CLAUDE.md

## What this project is

A bilingual (Swedish/English) mobile-first recipe app. Single HTML file on GitHub Pages + a Cloudflare Worker backend. No build step, no framework, no bundler.

**Live:** `erenias.github.io/recipe-app`  
**Stack:** Vanilla JS · Cloudflare Workers · Cloudflare KV · TheMealDB · Spoonacular · Claude Haiku (vision)

---

## File structure

```
index.html    — Complete frontend: CSS + HTML + ~3 300 lines of vanilla JS
worker.js     — Cloudflare Worker: API proxies, auth, scraping, vision
recipes.json  — Backup/example recipe data
HANDOFF.md    — Session handoff: what was built and why
CLAUDE.md     — This file
```

Everything lives in one repo folder. There is no `src/`, no `dist/`, no `package.json`.

---

## How to deploy

- **Frontend:** push `index.html` to the `main` branch → GitHub Pages auto-deploys
- **Worker:** paste `worker.js` into the Cloudflare Worker editor and hit Deploy
- Users set their Worker URL manually in the app's Settings tab

---

## Architecture

```
Browser (localStorage)
  └─ index.html (all JS inline)
       └─ Cloudflare Worker  ──►  TheMealDB API (free, no key)
            ├─ ?spc=          ──►  Spoonacular API  (SPOONACULAR_KEY secret)
            ├─ ?spc_ing=      ──►  Spoonacular findByIngredients
            ├─ ?spc_id=       ──►  Spoonacular recipe detail
            ├─ ?url=          ──►  Recipe URL scraper (JSON-LD)
            ├─ ?q=            ──►  Willys grocery store
            ├─ ?action=identify ► Anthropic Claude Haiku vision (ANTHROPIC_API_KEY)
            └─ ?action=load/save/register/login
                               ──►  Cloudflare KV (RECIPE_KV binding)
```

TheMealDB is called **directly from the browser** (no worker needed, it's free + CORS-open). Everything else goes through the worker to hide API keys.

---

## Worker bindings (required in Cloudflare dashboard)

| Type | Variable name | Used for |
|---|---|---|
| Secret | `SPOONACULAR_KEY` | Spoonacular search |
| Secret | `ANTHROPIC_API_KEY` | Ingredient photo scanning |
| KV Namespace | `RECIPE_KV` | User accounts, sessions, cloud sync |

**KV key schema:**
- `user:{username}` → `{ pinHash, createdAt }`
- `session:{token}` → `{ username }` (TTL 30 days)
- `data:{username}` → `{ recipes[], shoppingList[] }`

---

## Worker routes

| Param | Method | What it does |
|---|---|---|
| `?q=ingredient` | GET | Willys availability check |
| `?url=https://...` | GET | Scrape recipe page (JSON-LD → structured data) |
| `?spc=query` | GET | Spoonacular text search |
| `?spc_ing=ing1,ing2` | GET | Spoonacular ingredient-based search (`findByIngredients`) |
| `?spc_id=123` | GET | Fetch instructions for one Spoonacular recipe |
| `?action=register` | POST | Create account `{ username, pin }` |
| `?action=login` | POST | Login → returns `{ token, username }` |
| `?action=load` | GET | Fetch cloud data (requires `Authorization: Bearer <token>`) |
| `?action=save` | POST | Write cloud data (requires auth) |
| `?action=identify` | POST | Send base64 image to Claude, returns `{ ingredients[] }` |

---

## localStorage keys

| Key | Contents |
|---|---|
| `receptfinnaren_v1` | JSON — saved recipes array |
| `receptfinnaren_shopping_v1` | JSON — shopping list |
| `receptfinnaren_lang` | `'sv'` or `'en'` |
| `receptfinnaren_auth` | JSON — `{ username, token }` |
| `receptfinnaren_tab` | Last active view name (restored on refresh) |
| `workerUrl` | User's Worker endpoint URL |

---

## State variables (globals in index.html)

```js
lang                 // 'sv' | 'en'
recipes              // user's saved collection
shoppingList         // shopping items
filters              // { cookingType, protein, time, diet, source, mealType }
cookedFilters        // same shape minus source/prepTime
cookedSort           // 'date_desc' | 'rating_desc' | 'rating_asc' | 'alpha'
activeFilterCtx      // 'browse' | 'cooked' — which filter modal writes to
workerUrl
currentUser          // { username, token } | null
allMealDbRecipes     // ~315 recipes loaded once on first browse
mealDbLoading        // bool — a–z fetch in progress
mealDbAllLoaded      // bool — never resets
spoonacularResults   // live results, cleared on new search or nav away
pendingSharedRecipe  // recipe decoded from #share= URL, id='_shared_preview'
searchDebounce
_editingRecipeId

// Scanner
scannerIngredients   // detected/typed ingredient list
scannerState         // 'capture' | 'analyzing' | 'ingredients' | 'results'
scannerAllResults    // scored matches, grows when Spoonacular is fetched
scannerMealFilter
scannerSrcFilter     // 'mealdb' | 'spoonacular' | 'saved' | null
scannerSpcFetched    // bool — prevents showing Spoonacular button again
```

---

## Recipe object shape

```js
{
  id,            // uid() for saved | 'mdb_<n>' | 'spc_<n>' | '_shared_preview'
  title, url, site, image,
  cookingType,   // string[] — ['ugn','panna','airfryer','gryta','grill','wok','kokt']
  protein,       // string[] — ['kyckling','nötkött','fläsk','fisk','skaldjur','vegetarisk','vegan']
  mealType,      // 'middag' | 'frukost' | 'efterrätt' | 'drink' | 'mellanmål'
  time,          // total minutes | null
  prepTime,      // prep minutes | null (stored but not in filter UI)
  servings,
  ingredients,   // [{ name, amount, unit }]
  instructions,  // string[]
  favourite,     // bool — Önskelista tab
  cooked,        // bool — Lagade tab
  cookedAt,      // timestamp | null
  rating,        // 1–10 | null
  comment,       // string
  _mealdb,       // internal flag — from TheMealDB (not in user's recipes[])
  _spoonacular,  // internal flag — from Spoonacular (not yet saved)
  _shared,       // internal flag — from share link (not yet saved)
}
```

---

## Views and HTML structure

Six mutually exclusive `.view` divs switched by `showView(name)`:

| id | Nav label | What it shows |
|---|---|---|
| `view-browse` | Recept | Search, filters, recipe grid |
| `view-favourites` | Önskelista | `recipes` where `favourite === true` |
| `view-cooked` | Lagade | `recipes` where `cooked === true`, with ratings |
| `view-shopping` | Handla | Categorised shopping list |
| `view-add` | Ny | Add/edit recipe form |
| `view-settings` | Inst. | Auth, language, Worker URL, export/import |

**Overlays (fixed, z-indexed):**
- `#overlay` + `#panel` (z-index 200) — recipe detail panel, drag-to-close
- `#filter-modal` (z-index 300) — filter option picker
- `#scanner-overlay` (z-index 210) — ingredient scanner workflow
- `#login-screen` (z-index 1000) — shown when Worker URL set but not logged in

---

## CSS design tokens

```css
--bg: #f5f3ef          /* page background */
--primary: #1a5c38     /* forest green — buttons, active chips */
--accent: #2d9d57      /* bright green — highlights */
--text: #1a1a1a
--muted: #6b7280       /* secondary text, disabled */
--border: #e5e7eb
--danger: #dc2626
--radius: 12px
--nav-h: 64px
```

Grid is responsive: 2-col default → 4-col (640px) → 5-col (1100px) → 6-col (1400px).  
Uses `100dvh` (not `100vh`) to avoid iOS Safari viewport jump bugs.

---

## i18n pattern

All display strings live in the `T` object at the top of the script:
```js
const T = {
  en: { key: 'English text', ... },
  sv: { key: 'Svensk text', ... },
}
function t(key) { return T[lang][key] ?? T.en[key] ?? key; }
```

HTML elements that need translating use `data-i18n="key"` (updated by `applyLang()`).  
Ingredient names have a dedicated lookup table `INGREDIENT_SV` (English→Swedish) with an auto-generated reverse map `INGREDIENT_EN` (Swedish→English) built at startup.

---

## Key patterns and conventions

**Rendering:** Everything is innerHTML string concatenation — no framework, no VDOM. Re-render the whole section on state change.

**Filter context:** `openFilter(type, ctx)` sets `activeFilterCtx = ctx || 'browse'`. `setFilter(type, val)` writes to either `filters` or `cookedFilters` based on that context. Always pass the context when opening a filter from the cooked tab.

**Meal type "middag/lunch" merge:** The filter value is `'middag'` but it should match recipes tagged `'lunch'` too. Always use `mealTypeMatches(r.mealType, filterVal)` — never compare directly with `=== 'middag'`.

**Spoonacular is opt-in:** Never auto-fire Spoonacular. The button in `render()` and `triggerSpoonacular()` are the only entry points. Changing search text or filters clears `spoonacularResults` but does not re-fetch.

**Ingredient scanner Spoonacular:** Uses `?spc_ing=` (the `findByIngredients` endpoint), not `?spc=` (text search). Results are also pushed to `spoonacularResults` so `openRecipe()` can find them.

**Shared recipe preview:** `pendingSharedRecipe` has `id: '_shared_preview'`. It is not in `recipes[]`. `openRecipe('_shared_preview')` finds it via the extra lookup. `saveSharedRecipe()` copies it into `recipes[]` with a new `uid()`.

**ensureSaved:** Call this before modifying any MealDB or Spoonacular recipe. It silently copies the recipe from `allMealDbRecipes`/`spoonacularResults` into `recipes[]` so changes persist.

**Cloud sync is fire-and-forget:** `saveData()` writes to localStorage then calls `saveToCloud()` without awaiting. The app never blocks on cloud write.

**Image resize before upload:** Always resize to 800px max (canvas → JPEG 0.85) before posting to `?action=identify`. The image never leaves the browser at full resolution.

---

## Things that will bite you

1. **Recipe IDs are strings, not numbers.** `mdb_123`, `spc_456`, short random strings for saved. Never parse as int.

2. **`spoonacularResults` is ephemeral.** Cleared on new search, filter change, and view switch. Don't rely on it being populated.

3. **TheMealDB recipes are not in `recipes[]`** until `ensureSaved()` is called. They live in `allMealDbRecipes`. The same recipe can conceptually exist in both arrays — the saved copy is what gets persisted.

4. **The filter modal is shared** between browse and cooked tabs. `activeFilterCtx` must be set before opening it. If you add a new filter chip to a tab, make sure to pass the correct context.

5. **`prepTime` is stored on recipes but removed from the filter UI.** Don't remove it from the data structure — existing saved recipes have it.

6. **Shopping list categories are computed at render time.** `classifyIngredient()` runs on every `renderShopping()` call. There is no stored category field.

7. **Boot order matters:**  
   `checkShareLink()` → `loadData()` → `applyLang()` → `updateSettingsAuthSection()` → `loadAllMealDb()`  
   Then: show login screen OR `restoreTab()` + optionally open shared recipe after 400ms delay.

8. **Two filter bar divs in browse, two in cooked.** Browse: `#filter-bar` (row 1) + `#filter-bar-diet` (row 2). Cooked: `#cooked-filter-bar` (row 1) + `#cooked-filter-bar-2` (row 2). `updateCookedFilterChips()` queries both with a combined selector.

9. **`isSaved` is derived, not stored.** `const isSaved = !r._mealdb && !r._spoonacular && !r._shared`. The panel uses this to decide which buttons to show.

10. **Willys `willyStatus` persists in the shopping list item object.** It's not re-checked automatically — user must tap "Check Willys" again.
