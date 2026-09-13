import { ShowroomCatalogSchema } from '../contracts/showroom.js';
import { DEMO_MEDIA, validateDemoMedia } from './demo-media.js';
import type { StudioProvider } from './studio.js';

export function createFixtureStudioProvider(bytes: Uint8Array): StudioProvider {
  validateDemoMedia(bytes);
  const fixture = Uint8Array.from(bytes);
  return {
    async catalog(signal) {
      signal.throwIfAborted();
      return ShowroomCatalogSchema.parse({
        mode: 'fixture',
        products: [
          { id: 'tesla-model-y', name: 'Tesla Model Y (demo selection only)', ready: true },
          { id: 'toyota-tundra-hybrid', name: 'Toyota Tundra Hybrid (demo selection only)', ready: true },
        ],
        templates: [
          { id: 'VELOCITY', name: 'Velocity' }, { id: 'TOMORROW_DRIVE', name: 'Tomorrow drive' },
          { id: 'DREAM_ROUTE', name: 'Dream route' }, { id: 'HERO_OF_THE_DAY', name: 'Hero of the day' },
        ],
        videoProviders: [{ id: 'google-veo', available: true }, { id: 'openai-sora', available: true }],
        workerAvailable: true, rendererAvailable: true,
      });
    },
    async generate(snapshot, _photos, signal, progress) {
      signal.throwIfAborted();
      progress('registered_demo');
      return {
        bytes: Uint8Array.from(fixture), mimeType: 'video/mp4', provenance: 'mock_fixture',
        durationSeconds: DEMO_MEDIA.durationSeconds, productionMode: snapshot.input.selection.productionMode,
        renderMode: 'registered-demo',
      };
    },
    async cleanup() { return true; },
    async recoverCleanup() {},
  };
}
