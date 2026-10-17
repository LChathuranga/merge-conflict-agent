// Keeps API keys out of logs. Exact secrets are replaced wherever they appear, and common
// key shapes are masked as a backstop in case a key reaches the log by another route.

const MASK = '***';
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
];

export const redact = (text, secrets = []) => {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join(MASK);
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, prefix) => (typeof prefix === 'string' ? `${prefix}${MASK}` : MASK));
  }
  return out;
};
