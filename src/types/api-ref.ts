export type KeyPrefix = { prefix: string; alias: string };

export type OverlayState = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
};

export type TrySnapshot = {
  status: number;
  latencyMs: number;
  contentType: string;
  bytes: number;
  binary: boolean;
  body: string;
};
