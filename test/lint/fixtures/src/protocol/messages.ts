export interface Message {
  readonly type: string;
}

export const MESSAGE_TYPES = ['load'] as const;
