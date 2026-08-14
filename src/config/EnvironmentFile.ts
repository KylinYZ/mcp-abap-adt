import path from 'path';

export interface EnvironmentFileSelection {
  path: string;
  explicit: boolean;
}

export function selectEnvironmentFile(
  configuredPath: string | undefined,
  workingDirectory: string,
  defaultPath: string
): EnvironmentFileSelection {
  const trimmedPath = configuredPath?.trim();
  if (!trimmedPath) return { path: defaultPath, explicit: false };

  // A relative configured path belongs to the process that selected the SAP instance.
  return {
    path: path.resolve(workingDirectory, trimmedPath),
    explicit: true
  };
}
