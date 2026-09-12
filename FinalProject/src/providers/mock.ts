import type { BriefProvider, ProfileProvider } from './interfaces.js';

const mockProfiles = new WeakSet<ProfileProvider>();

export function createMockBriefProvider(): BriefProvider {
  return {
    name: 'mock',
    async create(input, signal) {
      signal.throwIfAborted();
      return {
        schemaVersion: 1,
        id: input.briefId,
        sessionId: input.sessionId,
        customerId: input.customer.customerId,
        productId: input.product.productId,
        contextRevision: input.context.revision,
        objective: 'Show a clearly labeled synthetic concept preview.',
        audiencePreferences: [...input.context.preferences],
        scenes: [
          { durationSeconds: 3, visual: 'Synthetic concept car on a neutral stage.', onScreenText: 'A concept for your next journey' },
          { durationSeconds: 3, visual: 'Concept car silhouette with an abstract background.', onScreenText: 'Synthetic demo — not a production vehicle' },
        ],
        callToAction: input.product.callToAction,
        templateId: input.product.templateId,
        durationSeconds: 6,
        provenance: 'mock',
      };
    },
  };
}

export function createMockProfileProvider(): ProfileProvider {
  const provider: ProfileProvider = {
    name: 'mock',
    async enrich(_input, signal) {
      signal.throwIfAborted();
      return {
        preferences: [],
        citations: [],
        provenance: 'demo',
        warnings: ['Synthetic demo profile; no external profile was retrieved.'],
      };
    },
  };
  mockProfiles.add(provider);
  return provider;
}

export function isMockProfileProvider(provider: ProfileProvider): boolean {
  return mockProfiles.has(provider);
}
