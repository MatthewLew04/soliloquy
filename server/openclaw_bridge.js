/**
 * openclaw_bridge.js — Keyword intent router for OpenClaw integration.
 *
 * Intercepts transcribed speech, matches trigger phrases to OpenClaw actions,
 * and executes them via the `openclaw` CLI.
 */

const { execFile } = require('child_process');
const path = require('path');

// ============================================================
// Wake word for OpenClaw ("claw" or "hey claw")
// ============================================================
const CLAW_WORDS = ['claw', 'claw,', 'claw.', 'claw!'];

function containsClawWord(text) {
  const words = text.toLowerCase().trim().split(/\s+/);
  // "hey claw" or just "claw" as a standalone word
  return words.some(w => CLAW_WORDS.includes(w.replace(/[,.:!?]/g, '')));
}

function extractClawQuery(text) {
  // Strip "hey claw" or "claw" and everything before it
  return text.replace(/^.*?\b(hey\s+)?claw\b[,.:!?\s]*/i, '').trim();
}

// ============================================================
// Intent definitions
// ============================================================
const INTENTS = [
  // === EMAIL ===
  {
    id: 'email_check',
    patterns: [
      /\b(?:what(?:'s| is) in my (?:mail|email|inbox))\b/i,
      /\b(?:check (?:my )?(?:mail|email|inbox))\b/i,
      /\b(?:any (?:new )?(?:emails?|mail))\b/i,
      /\b(?:read (?:my )?(?:mail|email|inbox))\b/i,
      /\b(?:show (?:my )?(?:mail|email|inbox))\b/i,
    ],
    extract: () => ({}),
    command: () => [
      'openclaw', 'agent', '--message',
      'List my latest 5 emails. For each email, show: sender name, subject, and a one-line summary. Be concise.',
      '--thinking', 'low',
    ],
  },
  // === EMAIL REPLY ===
  {
    id: 'email_reply',
    patterns: [
      /\b(?:respond|reply|write back) to (\w+)/i,
      /\b(?:email|mail) (\w+) (?:back|saying)/i,
    ],
    extract: (match) => ({ contact: match[1] }),
    // Needs two-step dictation: first capture the name, then the body
    needsFollowUp: true,
    command: (params) => [
      'openclaw', 'agent', '--message',
      `Reply to ${params.contact}'s latest email saying: ${params.body || ''}`,
      '--thinking', 'low',
    ],
  },
  // === SEND MESSAGE (via OpenClaw channels) ===
  {
    id: 'send_message',
    patterns: [
      /\b(?:send a? ?message|text|tell|message) (?:to )?(\w+)/i,
      /\b(?:dm|direct message) (\w+)/i,
    ],
    extract: (match) => ({ contact: match[1] }),
    needsFollowUp: true,
    command: (params) => [
      'openclaw', 'agent', '--message',
      `Send a message to ${params.contact} saying: ${params.body || ''}`,
      '--thinking', 'low',
    ],
  },
  // === CALENDAR ===
  {
    id: 'calendar',
    patterns: [
      /\b(?:what(?:'s| is) on my (?:calendar|schedule))\b/i,
      /\b(?:any (?:meetings?|events?) (?:today|tomorrow|this week))\b/i,
      /\b(?:my (?:calendar|schedule|agenda))\b/i,
      /\b(?:what (?:meetings?|events?) do i have)\b/i,
    ],
    extract: () => ({}),
    command: () => [
      'openclaw', 'agent', '--message',
      'Check my calendar for today. List any meetings or events with times. Be concise.',
      '--thinking', 'low',
    ],
  },
  // === WEB SEARCH ===
  {
    id: 'search',
    patterns: [
      /\b(?:search|look up|google|find(?: out)?) (?:for )?(.+)/i,
    ],
    extract: (match) => ({ query: match[1] }),
    command: (params) => [
      'openclaw', 'agent', '--message',
      params.query,
      '--thinking', 'low',
    ],
  },
  // === REMINDERS ===
  {
    id: 'reminder',
    patterns: [
      /\b(?:set a? ?reminder|remind me) (?:to )?(.+)/i,
    ],
    extract: (match) => ({ task: match[1] }),
    command: (params) => [
      'openclaw', 'agent', '--message',
      `Set a reminder: ${params.task}`,
      '--thinking', 'low',
    ],
  },
  // === NOTES ===
  {
    id: 'note',
    patterns: [
      /\b(?:take a? ?note|remember (?:that|this)|note (?:that|this|down)):?\s*(.+)/i,
      /\b(?:jot down|write down):?\s*(.+)/i,
    ],
    extract: (match) => ({ note: match[1] }),
    command: (params) => [
      'openclaw', 'agent', '--message',
      `Remember this note: ${params.note}`,
      '--thinking', 'low',
    ],
  },
];

// ============================================================
// Intent matching
// ============================================================

/**
 * Scans transcript for a matching OpenClaw intent.
 * @param {string} text — the raw transcript (already stripped of wake word)
 * @returns {{ intent: object, params: object } | null}
 */
function matchIntent(text) {
  for (const intent of INTENTS) {
    for (const pattern of intent.patterns) {
      const match = text.match(pattern);
      if (match) {
        const params = intent.extract(match);
        return { intent, params };
      }
    }
  }
  return null;
}

// ============================================================
// Execution
// ============================================================

/**
 * Executes an OpenClaw CLI command and returns the text output.
 * @param {object} intent
 * @param {object} params
 * @returns {Promise<string>}
 */
function executeIntent(intent, params) {
  return new Promise((resolve, reject) => {
    const args = intent.command(params);
    const bin = args.shift(); // 'openclaw'

    console.log(`  🦞 OpenClaw: ${bin} ${args.join(' ').substring(0, 120)}...`);

    execFile(bin, args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`  🦞 OpenClaw error: ${error.message}`);
        // Still return whatever output we got
        if (stdout && stdout.trim().length > 0) {
          resolve(stdout.trim());
        } else {
          resolve('Sorry, I couldn\'t complete that request right now.');
        }
        return;
      }
      const output = stdout.trim();
      if (!output) {
        resolve('I processed your request but got no response.');
      } else {
        resolve(output);
      }
    });
  });
}

/**
 * Fallback: send any unmatched query to the OpenClaw agent as a general message.
 * @param {string} query
 * @returns {Promise<string>}
 */
function executeGeneralQuery(query) {
  return executeIntent({
    command: () => ['openclaw', 'agent', '--message', query, '--thinking', 'low'],
  }, {});
}

// ============================================================
// Output condensing
// ============================================================

/**
 * Condenses OpenClaw's output for TTS playback (≤3 sentences).
 * Uses the Gemini condensing pass already in server.js.
 * @param {string} text — raw OpenClaw output
 * @returns {string} — trimmed output
 */
function condensForGlasses(text) {
  // Strip ANSI escape codes
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
  // Strip markdown formatting
  const noMd = clean
    .replace(/#{1,6}\s/g, '')      // headers
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')  // bold/italic
    .replace(/`([^`]+)`/g, '$1')    // inline code
    .replace(/^\s*[-*]\s+/gm, '')   // bullet points
    .replace(/\n{3,}/g, '\n\n');    // excess newlines

  // Take first 3 sentences or 300 chars, whichever is shorter
  const sentences = noMd.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  const trimmed = sentences.slice(0, 3).join(' ');
  return trimmed.length > 300 ? trimmed.substring(0, 297) + '...' : trimmed;
}

// ============================================================
// Health check
// ============================================================

/**
 * Checks if OpenClaw is installed and reachable.
 * @returns {Promise<boolean>}
 */
function checkOpenClaw() {
  return new Promise((resolve) => {
    execFile('openclaw', ['--version'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(false);
      } else {
        console.log(`  🦞 OpenClaw: ${stdout.trim()}`);
        resolve(true);
      }
    });
  });
}

module.exports = {
  containsClawWord,
  extractClawQuery,
  matchIntent,
  executeIntent,
  executeGeneralQuery,
  condensForGlasses,
  checkOpenClaw,
  INTENTS,
};
