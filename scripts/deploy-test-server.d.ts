export interface DeployConfig {
  serverUrl: string;
  username: string;
  branch: string;
  dryRun: boolean;
  hasToken: boolean;
  missing: string[];
  readonly token: string;
}

export function main(
  env: Record<string, string | undefined>,
  options?: {
    fetchImpl?: (url: string, init?: any) => Promise<any>;
    log?: (message: string) => void;
  },
): Promise<void>;

export function readDeployConfig(env: Record<string, string | undefined>): DeployConfig;

export function validateConfig(config: DeployConfig): void;

export function uploadBundle(options: {
  config: DeployConfig;
  code: string;
  env: Record<string, string | undefined>;
  fetchImpl?: (url: string, init?: any) => Promise<any>;
}): Promise<void>;

export function buildDeployBundle(config: DeployConfig): string;
