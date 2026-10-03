// Anything a model can read may be sent to a cloud provider, so files that commonly
// hold secrets (and git's own internals) are never exposed through tools or prompts.

const SENSITIVE_SEGMENT = /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|credentials(?:\.json)?)$/i;
const SENSITIVE_FILE = /(?:\.(?:pem|key|p12|pfx|jks|keystore)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i;

// posixPath: repo-relative path with forward slashes.
export const isSensitivePath = (posixPath) => {
  const segments = posixPath.split('/').filter(Boolean);
  return segments.some((segment) => SENSITIVE_SEGMENT.test(segment) || SENSITIVE_FILE.test(segment));
};

// Pathspecs for `git grep` / `git show` / `git log` that leave the same files out.
export const SENSITIVE_EXCLUDES = [
  ':(exclude,glob)**/.git/**',
  ':(exclude,glob)**/.env',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/.npmrc',
  ':(exclude,glob)**/.netrc',
  ':(exclude,glob)**/.pgpass',
  ':(exclude,glob)**/credentials',
  ':(exclude,glob)**/credentials.json',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.key',
  ':(exclude,glob)**/*.p12',
  ':(exclude,glob)**/*.pfx',
  ':(exclude,glob)**/*.jks',
  ':(exclude,glob)**/*.keystore',
  ':(exclude,glob)**/id_rsa*',
  ':(exclude,glob)**/id_dsa*',
  ':(exclude,glob)**/id_ecdsa*',
  ':(exclude,glob)**/id_ed25519*',
];
