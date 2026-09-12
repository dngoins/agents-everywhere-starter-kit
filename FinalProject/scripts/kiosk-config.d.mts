export interface KioskLaunchOptions {
  liveMedia: boolean;
  apiPort: number;
  uiPort: number;
  mediaPort: number;
}
export function optionalEnvironment(path: string): Promise<Record<string, string>>;
export function launchOptions(args: string[]): KioskLaunchOptions;
export function integrationEnvironments(input: {
  parent?: NodeJS.ProcessEnv;
  finalEnv?: Record<string, string>;
  movieEnv?: Record<string, string>;
  options: KioskLaunchOptions;
  deviceToken: string;
  mediaToken: string;
}): {
  api: NodeJS.ProcessEnv;
  ui: NodeJS.ProcessEnv;
  media: NodeJS.ProcessEnv;
  apiOrigin: string;
  uiOrigin: string;
  mediaOrigin: string;
};
