import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// CLI only. Loads the .env that lives next to the tool, not the one in the caller's cwd, so the
// commands work from inside any repository. Real environment variables still win.
// The core never imports this: an editor extension supplies its settings explicitly.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
