import { randomUUID } from 'node:crypto';

export function isLocalWebChatTurn(chatKey, entries, proactive) {
  return chatKey === 'private:web' && !proactive && entries.length > 0
    && entries.every(entry => entry.localConsole === true);
}

// Each decision belongs to one exact call in one running app. A canceled or
// expired request can never authorize a later attempt.
export class ConsoleApprovals {
  #pending = new Map();

  list() {
    return Array.from(this.#pending.values(), request => request.details);
  }

  request(tool, args, signal) {
    if (signal?.aborted) return Promise.resolve(false);
    const id = randomUUID();
    const details = { id, tool, args: structuredClone(args) };
    return new Promise(resolve => {
      const cancel = () => this.decide(id, false);
      const timer = setTimeout(cancel, 60000);
      this.#pending.set(id, {
        details,
        finish(allowed) {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          resolve(allowed);
        }
      });
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  decide(id, allowed) {
    const request = this.#pending.get(id);
    if (!request) return false;
    this.#pending.delete(id);
    request.finish(allowed === true);
    return true;
  }
}
