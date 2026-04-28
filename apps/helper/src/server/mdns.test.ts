import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BonjourAdvertiser } from './mdns';

describe('BonjourAdvertiser', () => {
  it('handles duplicate service-name errors without crashing the helper', async () => {
    const service = Object.assign(new EventEmitter(), {
      stop: vi.fn()
    });
    const destroy = vi.fn();
    const advertiser = new BonjourAdvertiser(async () => ({
      Bonjour: class {
        publish() {
          return service;
        }

        destroy() {
          destroy();
        }
      }
    }));

    await advertiser.start(55110);

    expect(service.listenerCount('error')).toBeGreaterThan(0);
    expect(() => service.emit('error', new Error('Service name is already in use on the network'))).not.toThrow();
    await advertiser.stop();
    expect(service.stop).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });
});
