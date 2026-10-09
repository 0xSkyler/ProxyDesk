export type WorkspacePointerButton = 'left' | 'middle' | 'right';

export type WorkspaceInputEvent =
  | {
      kind: 'pointer';
      action: 'move' | 'down' | 'up' | 'click';
      x: number;
      y: number;
      button?: WorkspacePointerButton;
      clickCount?: number;
    }
  | {
      kind: 'wheel';
      deltaX: number;
      deltaY: number;
    }
  | {
      kind: 'text';
      text: string;
    }
  | {
      kind: 'key';
      key: string;
    };
