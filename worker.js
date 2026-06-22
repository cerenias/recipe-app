// Cloudflare Worker — Receptfinnaren backend
// Routes:
//   ?q=           Willys availability check
//   ?url=         Recipe URL scraper
//   ?spc=         Spoonacular search
//   ?spc_id=      Spoonacular instructions for one recipe
//   ?action=      Auth + sync (register / login / load / save / identify)
//
// Required bindings (Cloudflare dashboard → Worker → Settings → Variables):
//   Secret: SPOONACULAR_KEY
//   Secret: ANTHROPIC_API_KEY   ← new: for ingredient photo scanning
//   KV namespace: RECIPE_KV  (create in KV tab, then bind with variable name RECIPE_KV)

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url       = new URL(request.url);
    const q         = url.searchParams.get('q');
    const recipeUrl = url.searchParams.get('url');
    const spc       = url.searchParams.get('spc');
    const spcId     = url.searchParams.get('spc_id');
    const action    = url.searchParams.get('action');

    if (recipeUrl) return scrapeRecipe(recipeUrl, corsHeaders);
    if (spc)       return spoonacularSearch(spc, url.searchParams, env, corsHeaders);
    if (url.searchParams.get('spc_ing')) return spoonacularByIngredients(url.searchParams.get('spc_ing'), env, corsHeaders);
    if (spcId)     return spoonacularInstructions(spcId, env, corsHeaders);
    if (q)         return checkWillys(q, corsHeaders);
    if (action === 'identify')     return identifyIngredients(request, env, corsHeaders);
    if (action === 'scan_recipe')  return scanRecipeFromImage(request, env, corsHeaders);
    if (action)    return handleAction(action, request, env, corsHeaders);

    return new Response(
      JSON.stringify({ error: 'Missing parameter' }),
      { headers: corsHeaders }
    );
  },
};

// ── Auth + Sync ───────────────────────────────────────────────────────────────
async function handleAction(action, request, env, corsHeaders) {
  if (!env.RECIPE_KV) {
    return new Response(
      JSON.stringify({ error: 'RECIPE_KV namespace not bound — add it in Cloudflare Worker → Settings → KV Namespace Bindings (variable name: RECIPE_KV)' }),
      { headers: corsHeaders, status: 500 }
    );
  }

  // ── Register ──────────────────────────────────────────────────────────────
  if (action === 'register') {
    let body;
    try { body = await request.json(); } catch { return errRes(corsHeaders, 'Invalid JSON'); }
    const { username, pin } = body || {};
    if (!username || !pin) return errRes(corsHeaders, 'username and pin required');

    const uname = username.toLowerCase().trim();
    if (!/^[a-z0-9_]{2,20}$/.test(uname))
      return errRes(corsHeaders, 'Username must be 2–20 characters: letters, numbers, underscore');
    if (String(pin).length < 4)
      return errRes(corsHeaders, 'PIN must be at least 4 characters');

    const existing = await env.RECIPE_KV.get(`user:${uname}`);
    if (existing) return new Response(JSON.stringify({ error: 'Username already taken' }), { headers: corsHeaders, status: 409 });

    const pinHash = await hashPin(uname, String(pin));
    await env.RECIPE_KV.put(`user:${uname}`, JSON.stringify({ pinHash, createdAt: Date.now() }));

    const token = generateToken();
    await env.RECIPE_KV.put(`session:${token}`, JSON.stringify({ username: uname }), { expirationTtl: 30 * 24 * 60 * 60 });

    return new Response(JSON.stringify({ ok: true, token, username: uname }), { headers: corsHeaders });
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  if (action === 'login') {
    let body;
    try { body = await request.json(); } catch { return errRes(corsHeaders, 'Invalid JSON'); }
    const { username, pin } = body || {};
    if (!username || !pin) return errRes(corsHeaders, 'username and pin required');

    const uname = username.toLowerCase().trim();
    const userJson = await env.RECIPE_KV.get(`user:${uname}`);
    if (!userJson) return new Response(JSON.stringify({ error: 'login_not_found' }), { headers: corsHeaders, status: 401 });

    const user = JSON.parse(userJson);
    const pinHash = await hashPin(uname, String(pin));
    if (pinHash !== user.pinHash)
      return new Response(JSON.stringify({ error: 'login_wrong_pin' }), { headers: corsHeaders, status: 401 });

    const token = generateToken();
    await env.RECIPE_KV.put(`session:${token}`, JSON.stringify({ username: uname }), { expirationTtl: 30 * 24 * 60 * 60 });

    return new Response(JSON.stringify({ ok: true, token, username: uname }), { headers: corsHeaders });
  }

  // ── Authenticated routes (load / save) ────────────────────────────────────
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return new Response(JSON.stringify({ error: 'Missing token' }), { headers: corsHeaders, status: 401 });

  const sessionJson = await env.RECIPE_KV.get(`session:${token}`);
  if (!sessionJson) return new Response(JSON.stringify({ error: 'session_expired' }), { headers: corsHeaders, status: 401 });

  const { username } = JSON.parse(sessionJson);

  if (action === 'load') {
    const dataJson = await env.RECIPE_KV.get(`data:${username}`);
    const data = dataJson ? JSON.parse(dataJson) : { recipes: [], shoppingList: [] };
    return new Response(JSON.stringify(data), { headers: corsHeaders });
  }

  if (action === 'save') {
    let body;
    try { body = await request.json(); } catch { return errRes(corsHeaders, 'Invalid JSON'); }
    await env.RECIPE_KV.put(`data:${username}`, JSON.stringify({
      recipes:      body.recipes      || [],
      shoppingList: body.shoppingList || [],
    }));
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  return errRes(corsHeaders, 'Unknown action');
}

function errRes(corsHeaders, msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { headers: corsHeaders, status });
}

async function hashPin(username, pin) {
  const data = new TextEncoder().encode(`${username}:${pin}`);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Spoonacular: find recipes by ingredients ──────────────────────────────────
async function spoonacularByIngredients(ingredients, env, corsHeaders) {
  const key = env.SPOONACULAR_KEY;
  if (!key) return errRes(corsHeaders, 'SPOONACULAR_KEY not set');
  try {
    const params = new URLSearchParams({
      ingredients,      // comma-separated ingredient list
      number: '16',
      ranking: '2',     // maximise used ingredients
      ignorePantry: 'true',
      apiKey: key,
    });
    const res = await fetch(
      `https://api.spoonacular.com/recipes/findByIngredients?${params}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!res.ok) return errRes(corsHeaders, `Spoonacular returned ${res.status}`);
    const data = await res.text();
    return new Response(data, { headers: corsHeaders });
  } catch (e) {
    return errRes(corsHeaders, e.message);
  }
}

// ── Spoonacular search ────────────────────────────────────────────────────────
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
      number: '16',
      addRecipeInformation: 'true',
      fillIngredients: 'true',
      sort: 'popularity',
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

// ── Spoonacular: fetch instructions for a single recipe ───────────────────────
async function spoonacularInstructions(id, env, corsHeaders) {
  const key = env.SPOONACULAR_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({ error: 'SPOONACULAR_KEY environment variable not set in Worker' }),
      { headers: corsHeaders }
    );
  }
  try {
    // Fetch full recipe information — includes both structured and plain-text instructions
    const res = await fetch(
      `https://api.spoonacular.com/recipes/${encodeURIComponent(id)}/information?includeNutrition=false&apiKey=${key}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Spoonacular returned ${res.status}` }),
        { headers: corsHeaders }
      );
    }
    const info = await res.json();

    // Prefer structured analyzed instructions (array of steps)
    const steps = [];
    (info.analyzedInstructions || []).forEach(block => {
      (block.steps || []).forEach(s => steps.push(s.step));
    });

    // Fall back to plain-text instructions field (strip HTML tags, split on newlines/sentences)
    if (!steps.length && info.instructions) {
      const plain = info.instructions
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      plain.split(/(?:\r?\n)+|(?<=\.)\s+(?=[A-Z0-9])/)
        .map(s => s.trim())
        .filter(s => s.length > 4)
        .forEach(s => steps.push(s));
    }

    return new Response(JSON.stringify({ steps }), { headers: corsHeaders });
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

    function parseDuration(str) {
      if (!str) return null;
      const m = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
      if (!m) return null;
      return (parseInt(m[1] || 0) * 60) + parseInt(m[2] || 0);
    }

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

    const ingredients = (recipe.recipeIngredient || []).map(ing => {
      const str = ing.trim();
      const m   = str.match(/^([\d.,½¼¾⅓⅔\s/-]+?)\s+([a-zA-ZåäöÅÄÖ]{1,10})\s+(.+)$/);
      if (m) return { name: m[3].trim(), amount: m[1].trim(), unit: m[2].trim() };
      return { name: str, amount: '', unit: '' };
    });

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

// ── Ingredient photo scanner (Claude Haiku vision) ───────────────────────────
async function identifyIngredients(request, env, corsHeaders) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    return errRes(corsHeaders, 'ANTHROPIC_API_KEY not set — add it as a Secret in Cloudflare Worker → Settings → Variables');
  }

  let body;
  try { body = await request.json(); } catch { return errRes(corsHeaders, 'Invalid JSON'); }

  const { image, mediaType } = body || {};
  if (!image) return errRes(corsHeaders, 'No image provided');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image },
            },
            {
              type: 'text',
              text: 'List all food ingredients clearly visible in this image. Return ONLY a JSON array of ingredient names in English, all lowercase. Exclude spices, salt, pepper, oil, vinegar, condiments, and water. Include vegetables, fruits, meat, fish, dairy, eggs, grains, and other main food items. Example: ["chicken breast", "broccoli", "milk", "carrots", "eggs"]. Respond with only the JSON array, no other text.',
            },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      return errRes(corsHeaders, `Anthropic API error ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim();

    let ingredients = [];
    try {
      ingredients = JSON.parse(text);
    } catch {
      const m = text.match(/\[[\s\S]*?\]/);
      if (m) { try { ingredients = JSON.parse(m[0]); } catch {} }
    }

    if (!Array.isArray(ingredients)) ingredients = [];
    ingredients = ingredients
      .filter(i => typeof i === 'string' && i.trim().length > 0)
      .map(i => i.trim().toLowerCase());

    return new Response(JSON.stringify({ ingredients }), { headers: corsHeaders });
  } catch (e) {
    return errRes(corsHeaders, e.message);
  }
}

// ── Scan a recipe photo → structured recipe data ─────────────────────────────
async function scanRecipeFromImage(request, env, corsHeaders) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return errRes(corsHeaders, 'ANTHROPIC_API_KEY not set');

  let body;
  try { body = await request.json(); } catch { return errRes(corsHeaders, 'Invalid JSON'); }

  // Support both single image (legacy) and multiple images array
  let images = body?.images;
  if (!images && body?.image) images = [{ image: body.image, mediaType: body.mediaType }];
  if (!images?.length) return errRes(corsHeaders, 'No image provided');

  const prompt = `You are extracting a recipe from a photo (e.g. a screenshot from Instagram, a cookbook page, or a handwritten recipe card).

Return ONLY a valid JSON object with these fields (omit fields you cannot determine):
{
  "title": "Recipe name",
  "ingredients": [
    { "name": "ingredient name in English", "amount": "150", "unit": "g" }
  ],
  "instructions": ["Step 1 text", "Step 2 text"],
  "servings": 4,
  "time": 30,
  "prep": 10
}

Rules:
- "time" and "prep" are integers in minutes
- "amount" is always a string (the number only, e.g. "2", "0.5")
- "unit" is the unit only (e.g. "g", "dl", "st", "tsp") — use metric units
- If amount/unit cannot be determined, use empty strings ""
- Ingredient names in English, lowercase
- Instructions as separate steps (one sentence or clear step per array item)
- If the image does not contain a recipe, return { "error": "No recipe found" }
- Return ONLY the JSON, no explanation`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.image } })),
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      return errRes(corsHeaders, `Anthropic error ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim();

    let recipe = {};
    try {
      recipe = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { recipe = JSON.parse(m[0]); } catch {} }
    }

    return new Response(JSON.stringify(recipe), { headers: corsHeaders });
  } catch (e) {
    return errRes(corsHeaders, e.message);
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
