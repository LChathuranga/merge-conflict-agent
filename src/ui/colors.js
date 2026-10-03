const enabled = () =>
  !process.env.NO_COLOR && (process.env.FORCE_COLOR || process.stdout.isTTY);

const wrap = (open, close = 39) => (text) =>
  enabled() ? `\u001b[${open}m${text}\u001b[${close}m` : String(text);

export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const magenta = wrap(35);
export const cyan = wrap(36);
export const gray = wrap(90);
export const bold = wrap(1, 22);

export const confidenceColor = (level) =>
  ({ high: green, medium: yellow, low: red })[level] ?? ((t) => String(t));

export const statusColor = (status) =>
  ({
    resolved: green,
    passed: green,
    'would-resolve': cyan,
    rejected: yellow,
    skipped: gray,
    failed: red,
  })[status] ?? ((t) => String(t));
