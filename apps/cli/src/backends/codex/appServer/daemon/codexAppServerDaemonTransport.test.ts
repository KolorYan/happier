import { describe, expect, it } from 'vitest';

import { withFakeCodexAppServerWebSocket, createCodexAppServerProcessEnv } from '../testkit/fakeCodexAppServer';
import { withTempDir } from '@/testkit/fs/tempDir';

import { isCodexThreadLoadedInAppServerDaemon } from './codexAppServerDaemonTransport';

describe('codexAppServerDaemonTransport', () => {
  it('reports only thread ids loaded by the existing Codex daemon', async () => {
    await withTempDir('happier-codex-daemon-transport-', async (root) => {
      await withFakeCodexAppServerWebSocket({ dir: root, loadedThreadIds: ['loaded-thread'] }, async ({ proxyPath }) => {
        const processEnv = createCodexAppServerProcessEnv(proxyPath);

        await expect(isCodexThreadLoadedInAppServerDaemon({
          cwd: root,
          processEnv,
          threadId: 'loaded-thread',
        })).resolves.toBe(true);
        await expect(isCodexThreadLoadedInAppServerDaemon({
          cwd: root,
          processEnv,
          threadId: 'idle-thread',
        })).resolves.toBe(false);
      });
    }, process.platform === 'win32' ? undefined : '/tmp');
  });
});
