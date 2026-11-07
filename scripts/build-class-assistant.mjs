import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const args of [['scripts/check-public-feed.mjs'], [require.resolve('next/dist/bin/next'), 'build']]) {
  const result = spawnSync(process.execPath, args, {
    cwd, stdio: 'inherit', env: {
      ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_BASE_PATH: '',
      RADAR_IDENTITY_BUILD: '0', NEXT_PUBLIC_IDENTITY_ENABLED: '0',
      NEXT_PUBLIC_IDENTITY_URL: '', NEXT_PUBLIC_CLASS_ASSISTANT_ENABLED: '1',
      NEXT_PUBLIC_CLASS_ASSISTANT_URL: '',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
