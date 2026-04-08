const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

const cache = {};
function getCache(key, ttlMs) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) { delete cache[key]; return null; }
  return entry.data;
}
function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

async function fetchMarketData() {
  const cached = getCache('market', 30 * 60 * 1000);
  if (cached) return cached;
  const symbols = [
    { symbol: '%5EIXIC', name: 'NASDAQ' },
    { symbol: '%5EGSPC', name: 'S&P 500' },
    { symbol: 'BTC-USD', name: 'Bitcoin' },
    { symbol: 'NVDA', name: 'NVIDIA' }
  ];
  const results = await Promise.all(symbols.map(async (s) => {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${s.symbol}?interval=1d&range=2d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await res.json();
      const meta = data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose || meta.previousClose;
      const change = ((price - prevClose) / prevClose * 100).toFixed(2);
      return {
        name: s.name,
        price: price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        change: parseFloat(change),
        changeStr: (change >= 0 ? '+' : '') + change + '%'
      };
    } catch {
      return { name: s.name, price: '\u2014', change: 0, changeStr: 'N/A' };
    }
  }));
  setCache('market', results);
  return results;
}

async function generateBriefing() {
  const cached = getCache('briefing', 6 * 60 * 60 * 1000);
  if (cached) return cached;
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set. Add it as an environment variable.');
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const prompt = `Today is ${today}. Search the web for the latest AI and tech industry news from the past 24 hours. Find the most significant developments across these categories:
1. AI Models & Research - New model releases, breakthroughs, benchmarks
2. Big Tech Moves - Google, Apple, Microsoft, Meta, Amazon, NVIDIA announcements
3. Startups & Funding - Notable raises, launches, acquisitions
4. AI Policy & Regulation - Government actions, safety developments
5. Products & Applications - New AI-powered products, integrations, tools

For EACH story, provide: a clear headline, 2-3 sentence summary, significance rating (1-5, where 5 = industry-shaping), source name.
Then end with a "What to Watch" section: 3-4 emerging trends or upcoming events in the next week.

Return ONLY valid JSON with this structure:
{"date":"...","stories":[{"category":"...","headline":"...","summary":"...","significance":4,"source":"..."}],"what_to_watch":[{"title":"...","description":"..."}]}`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
    messages: [{ role: 'user', content: prompt }]
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`);

  let textContent = '';
  for (const block of (data.content || [])) {
    if (block.type === 'text') textContent += block.text;
  }

  if (data.stop_reason === 'tool_use') {
    const toolResults = [];
    for (const block of data.content) {
      if (block.type === 'tool_use') {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Search completed.' });
      }
    }
    if (toolResults.length > 0) {
      const continueBody = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: data.content },
          { role: 'user', content: toolResults }
        ]
      });
      const res2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: continueBody
      });
      const data2 = await res2.json();
      textContent = '';
      for (const block of (data2.content || [])) {
        if (block.type === 'text') textContent += block.text;
      }
    }
  }

  let briefing;
  try {
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      briefing = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('No JSON found in response');
    }
  } catch (parseErr) {
    console.error('Parse error:', parseErr.message);
    briefing = {
      date: today,
      stories: [{ category: 'Error', headline: 'Briefing Parse Issue', summary: 'Could not parse the AI response. Try pulling again.', significance: 1, source: 'System' }],
      what_to_watch: []
    };
  }

  briefing.generated_at = new Date().toISOString();
  setCache('briefing', briefing);
  return briefing;
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/briefing') {
    try {
      const force = url.searchParams.get('force') === 'true';
      if (force) delete cache['briefing'];
      const briefing = await generateBriefing();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, briefing }));
    } catch (err) {
      console.error('Briefing error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/market') {
    try {
      const data = await fetchMarketData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/status') {
    const entry = cache['briefing'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hasCachedBriefing: !!entry,
      cacheAge: entry ? Math.round((Date.now() - entry.timestamp) / 60000) + ' min' : null,
      serverTime: new Date().toISOString()
    }));
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log('\n  Daily AI & Tech Briefing');
  console.log('  Running on http://localhost:' + PORT);
  console.log('  API Key: ' + (API_KEY ? 'Set' : 'MISSING - set ANTHROPIC_API_KEY env var') + '\n');
});
