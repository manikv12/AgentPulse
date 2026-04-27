import { hostname } from 'node:os';

export class BonjourAdvertiser {
  private bonjour?: {
    constructor?: unknown;
    publish: (options: {
      name: string;
      type: string;
      port: number;
      txt?: Record<string, string>;
    }) => { stop: () => void };
    destroy: () => void;
  };
  private service?: { stop: () => void };

  async start(port: number): Promise<void> {
    await this.stop();

    try {
      const imported = (await import('bonjour-service')) as unknown as {
        Bonjour: new (
          options?: Record<string, never>,
          errorCallback?: (error: unknown) => void
        ) => {
          publish: (options: {
            name: string;
            type: string;
            port: number;
            txt?: Record<string, string>;
          }) => { stop: () => void };
          destroy: () => void;
        };
      };
      this.bonjour = new imported.Bonjour({}, (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[agent-pulse] Bonjour advertiser error: ${message}`);
      });
      this.service = this.bonjour.publish({
        name: lanServiceName(),
        type: 'agentpulse',
        port,
        txt: { app: 'Agent Pulse' }
      });
    } catch {
      this.bonjour = undefined;
      this.service = undefined;
    }
  }

  async stop(): Promise<void> {
    this.service?.stop();
    this.bonjour?.destroy();
    this.service = undefined;
    this.bonjour = undefined;
  }
}

function lanServiceName(): string {
  const shortHost = hostname().split('.')[0]?.trim();
  return shortHost ? `Agent Pulse on ${shortHost}` : 'Agent Pulse';
}
