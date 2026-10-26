import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@atsusync/shared';

class Events extends EventEmitter {
  emitEvent(e: ServerEvent) {
    this.emit('event', e);
  }
  onEvent(fn: (e: ServerEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const events = new Events();
events.setMaxListeners(50);
