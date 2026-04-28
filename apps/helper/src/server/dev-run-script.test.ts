import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

describe('dev-run Cloudflare wiring', () => {
  it('tunnels the helper and lets the helper proxy the Vite dev UI', async () => {
    const script = await readFile(path.join(repoRoot, 'scripts/dev-run-all.sh'), 'utf8');

    expect(script).toContain('AGENT_PULSE_SKIP_MANAGED_TUNNEL=1');
    expect(script).toContain('AGENT_PULSE_TABLET_DEV_URL="$vite_origin"');
    expect(script).toContain('AGENT_PULSE_HELPER_PORT="$helper_port_for_vite"');
    expect(script).toContain('AGENT_PULSE_HMR_HOST="$hmr_host_pre"');
    expect(script).toContain('AGENT_PULSE_HMR_PROTOCOL="wss"');
    expect(script).toContain('AGENT_PULSE_HMR_CLIENT_PORT="443"');
    expect(script).toContain('pnpm --filter @agent-pulse/tablet dev');
    expect(script).toContain('vite_origin="${vite_url%/}"');
    expect(script).toContain('tunnel_origin="${helper_url//localhost/127.0.0.1}"');
    expect(script).toContain('if [[ "$tunnel_target" == "vite" ]]');
    expect(script).toContain('service: $tunnel_origin');
    expect(script).toContain('origin_url="$tunnel_origin"');
  });

  it('allows dev-run to stop the helper-managed tunnel before starting the Vite tunnel', async () => {
    const devServer = await readFile(path.join(repoRoot, 'apps/helper/src/dev-server.ts'), 'utf8');

    expect(devServer).toContain("process.env.AGENT_PULSE_SKIP_MANAGED_TUNNEL !== '1'");
  });

  it('allows the configured Cloudflare hostname through Vite host checks', async () => {
    const viteConfig = await readFile(path.join(repoRoot, 'apps/tablet/vite.config.ts'), 'utf8');

    expect(viteConfig).toContain('server: {');
    expect(viteConfig).toContain('allowedHosts');
    expect(viteConfig).toContain('AGENT_PULSE_ALLOWED_HOSTS');
    expect(viteConfig).toContain('AGENT_PULSE_HMR_HOST');
    expect(viteConfig).toContain('AGENT_PULSE_HMR_CLIENT_PORT');
    expect(viteConfig).toContain('settings.remoteAccess?.hostname');
    expect(viteConfig).toContain('new URL(publicUrl).hostname');
  });
});
