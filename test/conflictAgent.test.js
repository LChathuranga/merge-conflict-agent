import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConflictHunks, hasConflictMarkers } from '../src/conflict/parser.js';
import { applyResolutions } from '../src/conflict/apply.js';
import { proposeResolution, parseResolution, buildPrompt, findDiscardedSide, findDroppedLines } from '../src/agents/conflictAgent.js';

const FILE = [
  'const a = 1;',
  '<<<<<<< HEAD',
  'const b = 2;',
  '||||||| base',
  'const b = 0;',
  '=======',
  'const b = 3;',
  '>>>>>>> feature',
  'const c = 4;',
  '',
].join('\n');

test('proposeResolution sends hunk context to the llm and parses the reply', async () => {
  const [hunk] = parseConflictHunks(FILE);
  let seen;
  const llm = {
    complete: async (req) => {
      seen = req;
      return 'Sure!\n```json\n{"resolution": "const b = 2;\\nconst b = 3;", "explanation": "combine", "confidence": "high", "ambiguous": false}\n```';
    },
  };

  const result = await proposeResolution({ llm, file: 'a.js', fileText: FILE, hunk });

  assert.equal(result.resolution, 'const b = 2;\nconst b = 3;');
  assert.equal(result.needsApproval, false);
  assert.deepEqual(result.flags, []);
  assert.equal(seen.json, true);
  const prompt = seen.messages[0].content;
  assert.match(prompt, /File: a\.js/);
  assert.match(prompt, /const b = 2;/);
  assert.match(prompt, /const b = 0;/);
  assert.match(prompt, /const c = 4;/);
});

test('low confidence or ambiguous replies require approval', () => {
  assert.equal(parseResolution('{"resolution":"x","confidence":"low"}').needsApproval, true);
  assert.equal(parseResolution('{"resolution":"x","confidence":"high","ambiguous":true}').needsApproval, true);
  assert.equal(parseResolution('{"resolution":"x","confidence":"bogus"}').confidence, 'low');
});

test('parseResolution tolerates malformed JSON and rejects missing resolution', () => {
  assert.equal(parseResolution("{'resolution': 'x', 'confidence': 'high',}").resolution, 'x');
  assert.throws(() => parseResolution('no json here'), /no JSON/);
  assert.throws(() => parseResolution('{"explanation":"x"}'), /resolution/);
});

test('applyResolutions replaces marker blocks and leaves no markers', () => {
  const [hunk] = parseConflictHunks(FILE);
  const out = applyResolutions(FILE, [{ hunk, resolution: 'const b = 3;' }]);
  assert.equal(out, 'const a = 1;\nconst b = 3;\nconst c = 4;\n');
  assert.equal(hasConflictMarkers(out), false);
});

test('applyResolutions handles multiple hunks and CRLF files', () => {
  const text = ['<<<<<<< a', 'x', '=======', 'y', '>>>>>>> b', 'mid', '<<<<<<< a', '1', '=======', '2', '>>>>>>> b', ''].join('\r\n');
  const hunks = parseConflictHunks(text);
  const out = applyResolutions(text, [
    { hunk: hunks[0], resolution: 'y' },
    { hunk: hunks[1], resolution: '' },
  ]);
  assert.equal(out, 'y\r\nmid\r\n');
});

test('buildPrompt marks a missing base explicitly', () => {
  const text = ['<<<<<<< a', 'x', '=======', 'y', '>>>>>>> b'].join('\n');
  const [hunk] = parseConflictHunks(text);
  assert.match(buildPrompt({ file: 'f', fileText: text, hunk }), /--- BASE ---\n\(not available\)/);
});

test('findDiscardedSide flags picking one side when both sides changed from the base', () => {
  const [hunk] = parseConflictHunks(FILE); // ours b=2, base b=0, theirs b=3
  assert.equal(findDiscardedSide(hunk, 'const b = 3;'), 'ours');
  assert.equal(findDiscardedSide(hunk, '  const   b = 2;  '), 'theirs');
  assert.equal(findDiscardedSide(hunk, 'const b = 5;'), null);
});

test('findDiscardedSide allows taking the only side that changed, and flags plain markers', () => {
  const onlyOursChanged = { ours: 'x = 2', base: 'x = 1', theirs: 'x = 1' };
  assert.equal(findDiscardedSide(onlyOursChanged, 'x = 2'), null);

  const noBase = { ours: 'x = 2', base: null, theirs: 'x = 3' };
  assert.equal(findDiscardedSide(noBase, 'x = 3'), 'ours');

  const identical = { ours: 'x = 2', base: null, theirs: 'x = 2' };
  assert.equal(findDiscardedSide(identical, 'x = 2'), null);
});

test('a confident answer that keeps only one side still requires approval', async () => {
  const [hunk] = parseConflictHunks(FILE);
  const llm = {
    complete: async () => '{"resolution": "const b = 3;", "confidence": "high", "ambiguous": false}',
  };
  const result = await proposeResolution({ llm, file: 'a.js', fileText: FILE, hunk });
  assert.equal(result.needsApproval, true);
  assert.match(result.flags[0], /ours side's change would be discarded/);
});

test('proposeResolution retries once after unparseable JSON, then gives up', async () => {
  const [hunk] = parseConflictHunks(FILE);
  const replies = ['totally not json', '{"resolution": "const b = 5;", "confidence": "high"}'];
  const requests = [];
  const llm = { complete: async (req) => { requests.push(req); return replies.shift(); } };

  const result = await proposeResolution({ llm, file: 'a.js', fileText: FILE, hunk });
  assert.equal(result.resolution, 'const b = 5;');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).role, 'user');
  assert.match(requests[1].messages.at(-1).content, /could not be parsed/);

  const alwaysBad = { complete: async () => 'nope' };
  await assert.rejects(proposeResolution({ llm: alwaysBad, file: 'a.js', fileText: FILE, hunk }), /no JSON/);
});

test('findDroppedLines catches a merge that reverts one side or deletes a declaration', () => {
  const config = { ours: 'timeout: 60,', base: 'timeout: 30,', theirs: 'timeout: 30,\nretries: 3,' };
  assert.deepEqual(findDroppedLines(config, 'timeout: 30, retries: 3,'), { ours: ['timeout: 60,'], theirs: [] });
  assert.deepEqual(findDroppedLines(config, 'timeout: 60,\nretries: 3,'), { ours: [], theirs: [] });

  const price = {
    ours: 'const tax = subtotal * 0.2;\nreturn subtotal + tax;',
    base: 'return subtotal;',
    theirs: 'const discount = subtotal * 0.1;\nreturn subtotal - discount;',
  };
  const broken = findDroppedLines(price, 'return subtotal + tax - discount;');
  assert.ok(broken.ours.includes('const tax = subtotal * 0.2;'));
  assert.ok(broken.theirs.includes('const discount = subtotal * 0.1;'));
});

test('findDroppedLines without a base compares the two sides', () => {
  const hunk = { ours: 'a\nshared', base: null, theirs: 'b\nshared' };
  assert.deepEqual(findDroppedLines(hunk, 'a shared'), { ours: [], theirs: ['b'] });
});

test('proposeResolution flags a "confident" merge that dropped a side\'s lines', async () => {
  const text = ['<<<<<<< a', 'timeout: 60,', '||||||| base', 'timeout: 30,', '=======', 'timeout: 30,', 'retries: 3,', '>>>>>>> b'].join('\n');
  const [hunk] = parseConflictHunks(text);
  const llm = { complete: async () => '{"resolution": "timeout: 30,\\nretries: 3,\\n// merged", "confidence": "high", "ambiguous": false}' };
  const result = await proposeResolution({ llm, file: 'c.js', fileText: text, hunk });
  assert.equal(result.needsApproval, true);
  assert.match(result.flags[0], /missing ours changes: "timeout: 60,"/);
});

test('feedback rounds are replayed as a multi-turn conversation for the next proposal', async () => {
  const [hunk] = parseConflictHunks(FILE);
  let seen;
  const llm = {
    complete: async (req) => {
      seen = req;
      return '{"resolution": "const b = 2;\nconst b = 3;", "confidence": "high"}';
    },
  };
  const previous = { resolution: 'const b = 3;', explanation: 'take theirs', confidence: 'high' };

  await proposeResolution({
    llm, file: 'a.js', fileText: FILE, hunk,
    feedbackRounds: [{ proposal: previous, feedback: 'keep both values' }],
  });

  assert.deepEqual(seen.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(seen.messages[1].content, /take theirs/);
  assert.match(seen.messages[2].content, /rejected/);
  assert.match(seen.messages[2].content, /keep both values/);
});
