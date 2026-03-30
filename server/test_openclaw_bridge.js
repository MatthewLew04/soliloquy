/**
 * test_openclaw_bridge.js — Unit tests for the OpenClaw bridge module.
 * Run with: node test_openclaw_bridge.js
 */

const {
  containsClawWord,
  extractClawQuery,
  matchIntent,
  condensForGlasses,
  INTENTS,
} = require('./openclaw_bridge');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    console.error(`  ❌ ${testName}`);
  }
}

function assertEqual(actual, expected, testName) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    console.error(`  ❌ ${testName}: expected "${expected}", got "${actual}"`);
  }
}

// ============================================================
// 1. containsClawWord
// ============================================================
console.log('\n--- containsClawWord ---');

assert(containsClawWord('claw what is the weather'), 'detects "claw" at start');
assert(containsClawWord('hey claw check my email'), 'detects "hey claw"');
assert(containsClawWord('Claw, what is my schedule'), 'detects "Claw," with comma');
assert(containsClawWord('I said claw'), 'detects "claw" at end');
assert(containsClawWord('CLAW!'), 'detects "CLAW!" (uppercase + punctuation)');
assert(!containsClawWord('claws are sharp'), 'rejects "claws" (substring)');
assert(!containsClawWord('santa claus'), 'rejects "claus" (different word)');
assert(!containsClawWord('hello world'), 'rejects unrelated text');
assert(!containsClawWord(''), 'rejects empty string');

// ============================================================
// 2. extractClawQuery
// ============================================================
console.log('\n--- extractClawQuery ---');

assertEqual(
  extractClawQuery("claw what's in my mail"),
  "what's in my mail",
  'strips "claw" from start'
);
assertEqual(
  extractClawQuery("hey claw, check my calendar"),
  "check my calendar",
  'strips "hey claw," with comma'
);
assertEqual(
  extractClawQuery("Claw. Search for pizza"),
  "Search for pizza",
  'strips "Claw." with period'
);
assertEqual(
  extractClawQuery("I said claw what time is it"),
  "what time is it",
  'strips everything before and including "claw"'
);

// ============================================================
// 3. matchIntent — all 7 intent types
// ============================================================
console.log('\n--- matchIntent (all intents) ---');

// email_check
const emailCheck1 = matchIntent("what's in my mail");
assert(emailCheck1 !== null && emailCheck1.intent.id === 'email_check', 'email_check: "what\'s in my mail"');
const emailCheck2 = matchIntent("check my email");
assert(emailCheck2 !== null && emailCheck2.intent.id === 'email_check', 'email_check: "check my email"');
const emailCheck3 = matchIntent("any new emails");
assert(emailCheck3 !== null && emailCheck3.intent.id === 'email_check', 'email_check: "any new emails"');
const emailCheck4 = matchIntent("read my inbox");
assert(emailCheck4 !== null && emailCheck4.intent.id === 'email_check', 'email_check: "read my inbox"');
const emailCheck5 = matchIntent("show my mail");
assert(emailCheck5 !== null && emailCheck5.intent.id === 'email_check', 'email_check: "show my mail"');

// email_reply
const emailReply = matchIntent("respond to David");
assert(emailReply !== null && emailReply.intent.id === 'email_reply', 'email_reply: "respond to David"');
assert(emailReply.params.contact === 'David', 'email_reply: extracts contact "David"');
const emailReply2 = matchIntent("reply to Sarah");
assert(emailReply2 !== null && emailReply2.intent.id === 'email_reply', 'email_reply: "reply to Sarah"');

// send_message
const sendMsg = matchIntent("message Sarah");
assert(sendMsg !== null && sendMsg.intent.id === 'send_message', 'send_message: "message Sarah"');
assert(sendMsg.params.contact === 'Sarah', 'send_message: extracts contact "Sarah"');
const sendMsg2 = matchIntent("send a message to John");
assert(sendMsg2 !== null && sendMsg2.intent.id === 'send_message', 'send_message: "send a message to John"');
const sendMsg3 = matchIntent("text Mom");
assert(sendMsg3 !== null && sendMsg3.intent.id === 'send_message', 'send_message: "text Mom"');

// calendar
const cal1 = matchIntent("what's on my calendar");
assert(cal1 !== null && cal1.intent.id === 'calendar', 'calendar: "what\'s on my calendar"');
const cal2 = matchIntent("any meetings today");
assert(cal2 !== null && cal2.intent.id === 'calendar', 'calendar: "any meetings today"');
const cal3 = matchIntent("my schedule");
assert(cal3 !== null && cal3.intent.id === 'calendar', 'calendar: "my schedule"');

// search
const search = matchIntent("search for best pizza near me");
assert(search !== null && search.intent.id === 'search', 'search: "search for best pizza near me"');
assert(search.params.query === 'best pizza near me', 'search: extracts query');
const search2 = matchIntent("look up the weather");
assert(search2 !== null && search2.intent.id === 'search', 'search: "look up the weather"');

// reminder
const reminder = matchIntent("set a reminder to call dentist");
assert(reminder !== null && reminder.intent.id === 'reminder', 'reminder: "set a reminder to call dentist"');
assert(reminder.params.task === 'call dentist', 'reminder: extracts task');
const reminder2 = matchIntent("remind me to buy milk");
assert(reminder2 !== null && reminder2.intent.id === 'reminder', 'reminder: "remind me to buy milk"');

// note
const note = matchIntent("take a note meeting went well");
assert(note !== null && note.intent.id === 'note', 'note: "take a note meeting went well"');
assert(note.params.note === 'meeting went well', 'note: extracts text');
const note2 = matchIntent("jot down: call back at 3pm");
assert(note2 !== null && note2.intent.id === 'note', 'note: "jot down: call back at 3pm"');

// ============================================================
// 4. matchIntent — null on unrelated text
// ============================================================
console.log('\n--- matchIntent (negative cases) ---');

assert(matchIntent("hello world") === null, 'returns null: "hello world"');
assert(matchIntent("what time is it") === null, 'returns null: "what time is it"');
assert(matchIntent("") === null, 'returns null: empty string');
assert(matchIntent("the weather is nice today") === null, 'returns null: "the weather is nice today"');

// ============================================================
// 5. condensForGlasses
// ============================================================
console.log('\n--- condensForGlasses ---');

// Strips ANSI codes
const ansi = '\u001b[32mHello\u001b[0m world.\u001b[1m Test.\u001b[0m';
const cleanAnsi = condensForGlasses(ansi);
assert(!cleanAnsi.includes('\u001b['), 'strips ANSI codes');
assert(cleanAnsi.includes('Hello'), 'preserves text after stripping ANSI');

// Strips markdown
const md = '## Header\n\n**Bold text** and `inline code`.\n\n- Bullet one\n- Bullet two';
const cleanMd = condensForGlasses(md);
assert(!cleanMd.includes('##'), 'strips markdown headers');
assert(!cleanMd.includes('**'), 'strips markdown bold');
assert(!cleanMd.includes('`'), 'strips markdown inline code');

// Truncates to 3 sentences
const longText = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.';
const truncated = condensForGlasses(longText);
assert(!truncated.includes('Fourth'), 'truncates after 3 sentences');
assert(truncated.includes('Third'), 'keeps 3rd sentence');

// Truncates to 300 chars
const veryLong = 'A'.repeat(400) + '. End.';
const longTruncated = condensForGlasses(veryLong);
assert(longTruncated.length <= 300, 'truncates to ≤300 chars');

// ============================================================
// 6. Intent command() builders
// ============================================================
console.log('\n--- Intent command() builders ---');

for (const intent of INTENTS) {
  let testParams = {};
  if (intent.id === 'email_reply') testParams = { contact: 'Alice', body: 'Sounds good!' };
  else if (intent.id === 'send_message') testParams = { contact: 'Bob', body: 'Hey there' };
  else if (intent.id === 'search') testParams = { query: 'best sushi' };
  else if (intent.id === 'reminder') testParams = { task: 'buy milk' };
  else if (intent.id === 'note') testParams = { note: 'meeting at 3' };
  
  const cmd = intent.command(testParams);
  assert(Array.isArray(cmd), `${intent.id}: command() returns array`);
  assert(cmd[0] === 'openclaw', `${intent.id}: first arg is "openclaw"`);
  assert(cmd[1] === 'agent', `${intent.id}: second arg is "agent"`);
  assert(cmd.includes('--message'), `${intent.id}: includes --message flag`);
  assert(cmd.includes('--thinking'), `${intent.id}: includes --thinking flag`);
}

// ============================================================
// 7. needsFollowUp flag
// ============================================================
console.log('\n--- needsFollowUp flags ---');

const followUpIntents = INTENTS.filter(i => i.needsFollowUp);
const followUpIds = followUpIntents.map(i => i.id);
assert(followUpIds.includes('email_reply'), 'email_reply has needsFollowUp');
assert(followUpIds.includes('send_message'), 'send_message has needsFollowUp');
assert(followUpIds.length === 2, 'exactly 2 intents need follow-up');

// ============================================================
// Summary
// ============================================================
console.log('\n' + '='.repeat(50));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
