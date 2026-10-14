import type { Message } from '../protocol/messages.js';

export function handle(message: Message): string {
  return message.type;
}
