// Cloudflare Worker — Willys availability proxy
// Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker
// Paste this code, deploy, copy the URL, paste it in the app's Settings tab.

export default {
  async fetch(request) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const q = url.searchParams.get('q');

    if (!q || q.trim().length === 0) {
      return new Response(JSON.stringify({ available: false, error: 'Missing query parameter q' }), { headers: corsHeaders });
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
        return new Response(JSON.stringify({ available: false, error: `Willys returned ${res.status}` }), { headers: corsHeaders });
      }

      const data = await res.json();
      const results = data.results || [];
      const available = results.some(p => !p.outOfStock && p.online !== false);

      return new Response(JSON.stringify({
        available,
        count: results.length,
        query: q,
      }), { headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ available: false, error: e.message }), { headers: corsHeaders });
    }
  },
};
