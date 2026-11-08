// Loaded with --import in isolated fixtures when OMB_TEST_APPROVAL_CLOCK=1: while <data dir>/expire-approvals
// exists, every pending ask hits the broker's fifteen-minute deadline. No authorization or dispatch decision changes.
import { registerHooks } from 'node:module';
import { join } from 'node:path';
const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || process.env.OMB_TEST_APPROVAL_CLOCK !== '1') {
  throw new Error('The approval clock requires an explicitly isolated fixture');
}
const marker = join(dataDir, 'expire-approvals');
const fixtureTimeout = `
      import { existsSync as approvalMarkerExists } from 'node:fs';
      function approvalFixtureTimeout(callback, _delay) {
        const timer = setInterval(() => {
          if (!approvalMarkerExists(${JSON.stringify(marker)})) return;
          clearInterval(timer);
          callback();
        }, 25);
        return timer;
      }
    `;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith('/server/drivers/claude.ts')) {
      const source = String(result.source);
      // The broker's one timer is the only setTimeout in its scope.
      const anchor = 'const timeoutMs = opts.timeoutMs ?? 15 * 60_000;';
      if (source.split(anchor).length !== 2) throw new Error('Claude permission broker timer seam changed');
      return { ...result, source: fixtureTimeout + source.replace(anchor, `${anchor} const setTimeout = approvalFixtureTimeout;`) };
    }
    if (url.endsWith('/server/drivers/acp/core.ts')) {
      const source = String(result.source);
      // The ACP broker's one deadline call, by its exact shape; every other core timing stays real.
      const anchor = 'const timer = setTimeout(() => {';
      if (source.split(anchor).length !== 2) throw new Error('ACP permission broker timer seam changed');
      return { ...result, source: fixtureTimeout + source.replace(anchor, 'const timer = approvalFixtureTimeout(() => {') };
    }
    return result;
  },
});
