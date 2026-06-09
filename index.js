const http = require('http');

const PORT = process.env.PORT || 3000;

// In-memory store (resets on restart — Phase 2 will use a real DB)
const calls = [];

function extractData(body) {
  // Vapi sends call data in this structure
  const msg = body.message || {};
  const call = msg.call || body.call || {};
  const artifact = msg.artifact || {};
  const analysis = msg.analysis || {};

  // Pull caller number
  const phone = call.customer?.number || call.callerPhoneNumber || 'Unknown';

  // Pull transcript
  const transcript = artifact.transcript || msg.transcript || '';

  // Pull summary from analysis or build from transcript
  const summary = analysis.summary || msg.summary || transcript.slice(0, 500) || 'No summary available';

  // Try to extract name from summary/transcript
  const nameMatch = transcript.match(/(?:my name is|this is|I'm|I am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  const callerName = nameMatch ? nameMatch[1] : 'Unknown caller';

  // Detect matter type
  const text = (transcript + ' ' + summary).toLowerCase();
  let matter = 'General enquiry';
  if (text.includes('patent') || text.includes('invention') || text.includes('filing')) matter = 'Patent prosecution';
  else if (text.includes('trademark') || text.includes('brand') || text.includes('logo')) matter = 'Trademark';
  else if (text.includes('startup') || text.includes('investor') || text.includes('seed')) matter = 'IP strategy — startup';
  else if (text.includes('licens')) matter = 'Licensing agreement';
  else if (text.includes('trade secret') || text.includes('confidential') || text.includes('litigation')) matter = 'Trade secret & litigation';
  else if (text.includes('copyright')) matter = 'Copyright';

  // Detect urgency
  let urgency = 'Low';
  if (text.includes('urgent') || text.includes('asap') || text.includes('immediately') || text.includes('deadline')) urgency = 'High';
  else if (text.includes('soon') || text.includes('this week') || text.includes('publish')) urgency = 'Medium';

  return {
    id: 'call_' + Date.now(),
    callerName,
    phone,
    matter,
    urgency,
    summary,
    transcript,
    duration: call.endedAt && call.startedAt
      ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) + 's'
      : 'Unknown',
    recordingUrl: artifact.recordingUrl || null,
    timestamp: new Date().toISOString(),
    source: 'AI Receptionist',
    status: 'New',
  };
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Rapisardi IP webhook live', calls: calls.length }));
    return;
  }

  // GET all calls — for CRM to poll
  if (req.method === 'GET' && req.url === '/calls') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ calls: calls.slice().reverse() }));
    return;
  }

  // POST — Vapi sends call data here
  if (req.method === 'POST' && req.url === '/vapi-webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const msgType = parsed.message?.type || parsed.type;

        // Only process end-of-call reports
        if (msgType === 'end-of-call-report' || msgType === 'call.ended' || !msgType) {
          const record = extractData(parsed);
          calls.push(record);
          console.log(`[${new Date().toISOString()}] New call logged:`, record.callerName, '|', record.matter, '|', record.urgency);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: record.id }));
        } else {
          // Acknowledge other event types silently
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ignored: msgType }));
        }
      } catch (e) {
        console.error('Parse error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Rapisardi webhook running on port ${PORT}`));
