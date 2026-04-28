import { hostname } from 'node:os';
import type { EventEmitter } from 'node:events';

type BonjourService = {
  stop: () => void;
  on?: EventEmitter['on'];
};

type BonjourInstance = {
  publish: (options: {
    name: string;
    type: string;
    port: number;
    txt?: Record<string, string>;
  }) => BonjourService;
  destroy: () => void;
};

type BonjourModule = {
  Bonjour: new (
    options?: Record<string, never>,
    errorCallback?: (error: unknown) => void
  ) => BonjourInstance;
};

const defaultLoadBonjour = async (): Promise<BonjourModule> =>
  (await import('bonjour-service')) as unknown as BonjourModule;

export class BonjourAdvertiser {
  private bonjour?: BonjourInstance;
  private service?: BonjourService;

  constructor(private readonly loadBonjour: () => Promise<BonjourModule> = defaultLoadBonjour) {}

  async start(port: number): Promise<void> {
    await this.stop();

    try {
      const imported = await this.loadBonjour();
      this.bonjour = new imported.Bonjour({}, (error) => {
        warnBonjourError(error);
      });
      this.service = this.bonjour.publish({
        name: lanServiceName(),
        type: 'agentpulse',
        port,
        txt: { app: 'Agent Pulse' }
      });
      this.service.on?.('error', warnBonjourError);
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

function warnBonjourError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[agent-pulse] Bonjour advertiser error: ${message}`);
}
