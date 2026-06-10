const http = require('http');
const PORT = process.env.PORT || 3000;
const calls = [];

function extractName(transcript) {
  if (!transcript) return null;

  // Patterns that indicate the caller just gave their name
  const namePatterns = [
    // After "my name is" or "I'm" or "this is"
    /(?:my name is|i'm|i am|this is|it's|its)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/gi,
    // After the AI asks for name and caller responds
    /(?:name[^.?]*\?[^.]*\n[^:]*:\s*)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/gi,
    // Direct name confirmation pattern: "Thank you, [Name]" or "Thank you [Name]"
    /thank you,?\s+(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/gi,
  ];

  // Common false positives to reject
  const blacklist = [
    'very well', 'very good', 'of course', 'interested in', 'doing very',
    'getting ready', 'looking into', 'speaking with', 'calling about',
    'rapisardi', 'rappasardi', 'intellectual', 'property', 'good morning',
    'good afternoon', 'good evening', 'thank you', 'how may', 'how can',
    'please hold', 'one moment', 'right now', 'certainly', 'absolutely',
    'of course', 'no problem', 'that is', 'this is a', 'patent prosecution',
    'general enquiry', 'trademark', 'unknown caller'
  ];

  for (const pattern of namePatterns) {
    let match;
    while ((match = pattern.exec(transcript)) !== null) {
      const candidate = match[1].trim();
      const lower = candidate.toLowerCase();
      
      // Reject blacklisted phrases
      if (blacklist.some(b => lower.includes(b))) continue;
      
      // Must have at least 2 words (first + last name)
      const words = candidate.split(/\s+/);
      if (words.length < 2) continue;
      
      // Each word should look like a name (capitalised, 2+ chars, no numbers)
      const looksLikeName = words.every(w => /^[A-Z][a-z]{1,}$/.test(w));
      if (!looksLikeName) continue;

      // Reject if any word is a common English word
      const commonWords = ['the','and','for','you','this','that','with','from',
        'have','will','been','they','them','their','said','well','good','very',
        'call','your','hello','thank','sure','okay','yes','right','just','about'];
      if (words.some(w => commonWords.includes(w.toLowerCase()))) continue;

      return candidate;
    }
  }

  // Last resort: look for "name" + next capitalised phrase in AI turns
  const lines = transcript.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].toLowerCase();
    if ((line.includes('your name') || line.includes('full name') || line.includes('may i take')) && lines[i].includes('AI:')) {
      // Next user line
      const nextUser = lines.slice(i+1).find(l => l.match(/^(User|Caller):/i));
      if (nextUser) {
        const answer = nextUser.replace(/^(User|Caller):\s*/i, '').trim();
        const words = answer.split(/\s+/);
        if (words.length >= 2 && words.length <= 4) {
          const looksLikeName = words.every(w => /^[A-Z][a-z]{1,}$/.test(w));
          if (looksLikeName) return answer;
        }
      }
    }
  }

  return null;
}

function extractData(body) {
  const msg = body.message || {};
  const call = msg.call || body.call || {};
  const artifact = msg.artifact || {};
  const analysis = msg.analysis || {};

  const phone = call.customer?.number || call.callerPhoneNumber || 'Unknown';
  const transcript = artifact.transcript || msg.transcript || '';
  const summary = analysis.summary || msg.summary || transcript.slice(0, 500) || 'No summary available';

  const callerName = extractName(transcript) || 'Unknown caller';

  // Matter detection
  const text = (transcript + ' ' + summary).toLowerCase();
  let matter = 'General enquiry';
  if (text.includes('patent') || text.includes('invention') || text.includes('filing')) matter = 'Patent prosecution';
  else if (text.includes('trademark') || text.includes('brand') || text.includes('logo')) matter = 'Trademark';
  else if (text.includes('startup') || text.includes('investor') || text.includes('seed')) matter = 'IP strategy — startup';
  else if (text.includes('licens')) matter = 'Licensing agreement';
  else if (text.includes('trade secret') || text.includes('confidential') || text.includes('litigation')) matter = 'Trade secret & litigation';
  else if (text.includes('copyright')) matter = 'Copyright';

  // Urgency
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Rapisardi IP webhook live', calls: calls.length }));
    return;
  }

  if (req.method === 'GET' && req.url === '/calls') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ calls: calls.slice().reverse() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/vapi-webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const msgType = parsed.message?.type || parsed.type;
        if (msgType === 'end-of-call-report' || msgType === 'call.ended' || !msgType) {
          const record = extractData(parsed);
          calls.push(record);
          console.log(`[${new Date().toISOString()}] Call logged: ${record.callerName} | ${record.matter} | ${record.urgency}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: record.id }));
        } else {
          res.writeHead(200); res.end(JSON.stringify({ success: true, ignored: msgType }));
        }
      } catch (e) {
        console.error('Parse error:', e.message);
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Rapisardi webhook running on port ${PORT}`));
