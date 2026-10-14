import type { Message } from '../protocol/messages.js';

export function describe(message: Message): string {
  return message.type;
}
