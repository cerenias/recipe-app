// Cloudflare Worker — Willys availability proxy + Recipe URL scraper
// Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker
// Paste this code, deploy, copy the URL, paste it in the app's Settings tab.

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url        = new URL(request.url);
    const q          = url.searchParams.get('q');
    const recipeUrl  = url.searchParams.get('url');
    const spc        = url.searchParams.get('spc');

    if (recipeUrl) return scrapeRecipe(recipeUrl, corsHeaders);
    if (spc)       return spoonacularSearch(spc, url.searchParams, env, corsHeaders);
    if (q)         return checkWillys(q, corsHeaders);

    return new Response(
      JSON.stringify({ error: 'Missing parameter: use ?q= for Willys, ?url= for recipe scraping, or ?spc= for Spoonacular' }),
      { headers: corsHeaders }
    );
  },
};

// ── Spoonacular proxy ─────────────────────────────────────────────────────────
async function spoonacularSearch(query, params, env, corsHeaders) {
  const key = env.SPOONACULAR_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({ error: 'SPOONACULAR_KEY environment variable not set in Worker' }),
      { headers: corsHeaders }
    );
  }
  try {
    const spcParams = new URLSearchParams({
      query,
      number: '12',
      addRecipeInformation: 'true',
      fillIngredients: 'true',
      apiKey: key,
    });
    const diet      = params.get('diet');
    const equipment = params.get('equipment');
    if (diet)      spcParams.set('diet', diet);
    if (equipment) spcParams.set('equipment', equipment);

    const res = await fetch(`https://api.spoonacular.com/recipes/complexSearch?${spcParams}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Spoonacular returned ${res.status}` }),
        { headers: corsHeaders }
      );
    }
    const data = await res.text();
    return new Response(data, { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: corsHeaders });
  }
}

// ── Recipe scraper ────────────────────────────────────────────────────────────
async function scrapeRecipe(recipeUrl, corsHeaders) {
  try {
    const res = await fetch(recipeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
      },
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Sidan svarade med HTTP ${res.status}` }),
        { headers: corsHeaders }
      );
    }

    const html = await res.text();

    // Find all JSON-LD <script> blocks and look for @type: Recipe
    const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match, recipe = null;

    while ((match = jsonLdRe.exec(html)) !== null) {
      try {
        const data  = JSON.parse(match[1]);
        const items = Array.isArray(data) ? data : [data];
        const flat  = items.flatMap(d => d['@graph'] ? d['@graph'] : [d]);
        const found = flat.find(d => {
          const t = d['@type'];
          return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
        });
        if (found) { recipe = found; break; }
      } catch {}
    }

    if (!recipe) {
      return new Response(
        JSON.stringify({ error: 'Ingen receptdata hittades på sidan. Prova en annan receptsida.' }),
        { headers: corsHeaders }
      );
    }

    // ISO 8601 duration → minutes  e.g. "PT1H15M" → 75
    function parseDuration(str) {
      if (!str) return null;
      const m = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
      if (!m) return null;
      return (parseInt(m[1] || 0) * 60) + parseInt(m[2] || 0);
    }

    // Normalize instructions
    let instructions = [];
    const rawIns = recipe.recipeInstructions;
    if (Array.isArray(rawIns)) {
      instructions = rawIns.flatMap(s => {
        if (typeof s === 'string') return [s.trim()];
        if (s.text)            return [s.text.trim()];
        if (s.itemListElement) return s.itemListElement.map(x => (x.text || String(x)).trim());
        return [];
      }).filter(Boolean);
    } else if (typeof rawIns === 'string') {
      instructions = rawIns.split(/\n+/).map(s => s.trim()).filter(Boolean);
    }

    // Normalize ingredients — try to split "300 g nötfärs" into {amount, unit, name}
    const ingredients = (recipe.recipeIngredient || []).map(ing => {
      const str = ing.trim();
      const m   = str.match(/^([\d.,½¼¾⅓⅔\s/-]+?)\s+([a-zA-ZåäöÅÄÖ]{1,10})\s+(.+)$/);
      if (m) return { name: m[3].trim(), amount: m[1].trim(), unit: m[2].trim() };
      return { name: str, amount: '', unit: '' };
    });

    // Normalize image
    let image = null;
    const img = recipe.image;
    if (img) {
      if (typeof img === 'string') image = img;
      else if (img.url)            image = img.url;
      else if (Array.isArray(img)) {
        const first = img[0];
        image = typeof first === 'string' ? first : (first?.url || null);
      }
    }

    // Servings
    let servings = null;
    const y = Array.isArray(recipe.recipeYield) ? recipe.recipeYield[0] : recipe.recipeYield;
    if (y) { const m = String(y).match(/\d+/); if (m) servings = parseInt(m[0]); }

    return new Response(JSON.stringify({
      title:      recipe.name || '',
      image,
      instructions,
      ingredients,
      prepTime:   parseDuration(recipe.prepTime),
      totalTime:  parseDuration(recipe.totalTime) || parseDuration(recipe.cookTime),
      servings,
    }), { headers: corsHeaders });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: corsHeaders });
  }
}

// ── Willys availability ───────────────────────────────────────────────────────
async function checkWillys(q, corsHeaders) {
  if (!q || q.trim().length === 0) {
    return new Response(
      JSON.stringify({ available: false, error: 'Missing query parameter q' }),
      { headers: corsHeaders }
    );
  }
  try {
    const searchUrl = `https://www.willys.se/search?q=${encodeURIComponent(q.trim())}&type=PRODUCTS`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'sv-SE,sv;q=0.9',
      },
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ available: false, error: `Willys returned ${res.status}` }),
        { headers: corsHeaders }
      );
    }

    const data      = await res.json();
    const results   = data.results || [];
    const available = results.some(p => !p.outOfStock && p.online !== false);

    return new Response(
      JSON.stringify({ available, count: results.length, query: q }),
      { headers: corsHeaders }
    );

  } catch (e) {
    return new Response(
      JSON.stringify({ available: false, error: e.message }),
      { headers: corsHeaders }
    );
  }
}
