export type WorkspacePreviewMode = 'hidden' | 'visible' | 'active';

export interface WorkspacePreviewFrame {
  workspaceId: number;
  sequence: number;
  capturedAt: string;
  latencyMs: number;
  dataUrl?: string;
  error?: string;
  recovering?: boolean;
}
