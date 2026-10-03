import { jsonrepair } from 'jsonrepair';

// Models wrap JSON in prose or code fences and sometimes emit slightly broken JSON.
export const parseJsonObject = (raw, label) => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`${label} returned no JSON object`);
  }
  return JSON.parse(jsonrepair(raw.slice(start, end + 1)));
};
