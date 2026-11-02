// Local settings (OWNER_EMAIL and friends) from a git-ignored .env, when present.
// Production sets real environment variables instead. Import this first.
import fs from 'node:fs';
import path from 'node:path';

const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile) && typeof (process as any).loadEnvFile === 'function') {
  (process as any).loadEnvFile(envFile);
}
