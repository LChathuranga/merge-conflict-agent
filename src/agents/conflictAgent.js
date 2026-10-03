import { parseJsonObject } from './json.js';

const CONTEXT_LINES = 15;
const CONFIDENCE = ['high', 'medium', 'low'];

const SYSTEM_PROMPT = `You are the Conflict Agent in a Git merge-conflict assistant.
You are read-only: you never edit files, you only propose a resolution for ONE conflict hunk.

Rules:
- Combine the intent of both sides ("ours" = target branch, "theirs" = incoming branch). Use the base (common ancestor) when provided to see what each side changed.
- Output only the final code that should replace the whole conflict block. No conflict markers.
- Keep the surrounding file's indentation, style and line breaks. Write each line break inside the JSON string as \n; never collapse several lines of code onto one line.
- Set "ambiguous" to true (and confidence to "low") whenever a correct merge requires a judgment call a human should make. This includes: both sides assign different values to the same variable, constant, setting or return value; keeping one side would silently discard the other side's change; or the sides implement incompatible behavior. Still give your best guess.
- Only set "ambiguous" to false when the two changes are independent and can both be kept as-is, or when one side is unchanged from the base.
- Never invent a new value that neither side contains just to avoid choosing.

Respond with ONLY a JSON object:
{"resolution": string, "explanation": string, "confidence": "high" | "medium" | "low", "ambiguous": boolean}`;

const fence = (label, body) => `--- ${label} ---\n${body ?? '(not available)'}`;

export const extractContext = (fileText, hunk, radius = CONTEXT_LINES) => {
  const lines = fileText.split(/\r?\n/);
  const before = lines.slice(Math.max(0, hunk.startLine - 1 - radius), hunk.startLine - 1);
  const after = lines.slice(hunk.endLine, hunk.endLine + radius);
  return { before: before.join('\n'), after: after.join('\n') };
};

export const buildPrompt = ({ file, fileText, hunk, intent }) => {
  const { before, after } = extractContext(fileText, hunk);
  return [
    `File: ${file}`,
    hunk.oursLabel || hunk.theirsLabel ? `Branches: ours=${hunk.oursLabel} theirs=${hunk.theirsLabel}` : null,
    intent ? `Known intent of the branches:\n${intent}` : null,
    fence('code before conflict', before),
    fence('OURS', hunk.ours),
    fence('BASE', hunk.base),
    fence('THEIRS', hunk.theirs),
    fence('code after conflict', after),
  ]
    .filter(Boolean)
    .join('\n\n');
};

export const parseResolution = (raw) => {
  const data = parseJsonObject(raw, 'Conflict Agent');
  if (typeof data.resolution !== 'string') {
    throw new Error('Conflict Agent response is missing a string "resolution"');
  }

  const confidence = CONFIDENCE.includes(data.confidence) ? data.confidence : 'low';
  const ambiguous = data.ambiguous === true || confidence === 'low';

  return {
    resolution: data.resolution,
    explanation: String(data.explanation ?? ''),
    confidence,
    needsApproval: ambiguous,
  };
};

const normalize = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

// A resolution that is just one side verbatim silently throws away the other
// side's edit when both sides changed the code. Models routinely do this while
// claiming high confidence, so the decision is made in code, not trusted to them.
export const findDiscardedSide = (hunk, resolution) => {
  const resolved = normalize(resolution);
  const ours = normalize(hunk.ours);
  const theirs = normalize(hunk.theirs);
  if (ours === theirs) return null;

  const base = hunk.base === null ? null : normalize(hunk.base);
  if (resolved === theirs && (base === null || ours !== base)) return 'ours';
  if (resolved === ours && (base === null || theirs !== base)) return 'theirs';
  return null;
};

const meaningfulLines = (text) =>
  (text ?? '').split(/\r?\n/).map(normalize).filter(Boolean);

// Lines a side added or changed (absent from the base, or from the other side when
// there is no base) that the resolution does not contain. Catches models that
// "merge" by quietly reverting one side's edit or deleting a declaration.
export const findDroppedLines = (hunk, resolution) => {
  // Trailing , and ; are layout (last property, joined lines), not content.
  const strip = (line) => line.replace(/[,;]+$/, '');
  const resolved = normalize(resolution);
  const toSet = (text) => new Set(meaningfulLines(text).map(strip));
  const baseLines = toSet(hunk.base);
  const dropped = (side, other) => {
    const reference = hunk.base === null ? toSet(other) : baseLines;
    return meaningfulLines(side).filter((line) => !reference.has(strip(line)) && !resolved.includes(strip(line)));
  };
  return { ours: dropped(hunk.ours, hunk.theirs), theirs: dropped(hunk.theirs, hunk.ours) };
};

const describeLines = (lines) => lines.slice(0, 2).map((l) => `"${l}"`).join(', ') + (lines.length > 2 ? ', ...' : '');

// llm: object with complete({ system, messages, json }) -> Promise<string>
// feedbackRounds: [{ proposal, feedback }] for proposals the user turned down, oldest first.
export const proposeResolution = async ({ llm, file, fileText, hunk, intent, feedbackRounds = [] }) => {
  const messages = [{ role: 'user', content: buildPrompt({ file, fileText, hunk, intent }) }];
  for (const { proposal: previous, feedback } of feedbackRounds) {
    messages.push(
      {
        role: 'assistant',
        content: JSON.stringify({
          resolution: previous.resolution,
          explanation: previous.explanation,
          confidence: previous.confidence,
        }),
      },
      {
        role: 'user',
        content:
          `The user rejected that resolution.${feedback ? ` Their feedback: ${feedback}` : ''}\n` +
          'Propose a different resolution that addresses it. Reply with ONLY the same JSON object.',
      }
    );
  }
  const ask = (msgs) => llm.complete({ system: SYSTEM_PROMPT, messages: msgs, json: true });

  const raw = await ask(messages);
  let proposal;
  try {
    proposal = parseResolution(raw);
  } catch (error) {
    // Small local models sometimes emit broken JSON; one corrective retry fixes most of it.
    const retryRaw = await ask([
      ...messages,
      { role: 'assistant', content: raw.trim() || '(empty reply)' },
      { role: 'user', content: `Your reply could not be parsed (${error.message}). Reply again with ONLY the JSON object and no other text.` },
    ]);
    proposal = parseResolution(retryRaw);
  }

  const discarded = findDiscardedSide(hunk, proposal.resolution);
  const flags = [];
  if (discarded) {
    flags.push(`resolution keeps only one side, so the ${discarded} side's change would be discarded`);
  } else {
    const dropped = findDroppedLines(hunk, proposal.resolution);
    for (const side of ['ours', 'theirs']) {
      if (dropped[side].length > 0) {
        flags.push(`resolution is missing ${side} changes: ${describeLines(dropped[side])}`);
      }
    }
  }

  return { ...proposal, flags, needsApproval: proposal.needsApproval || flags.length > 0 };
};
