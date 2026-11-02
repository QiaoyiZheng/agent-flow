// Things the user should see: connection failures, lost connections, broken terminal streams, Herdr down.
// The same notice repeated (a retry loop) is counted instead of piling up.

import type { Notice } from "@af/core";

export class Notices {
  list: Notice[] = [];
  private listeners = new Set<(n: Notice) => void>();
  private n = 0;

  constructor(private max = 200) {}

  add(level: Notice["level"], source: string, text: string, detail?: string): Notice {
    // the same thing again (a retry loop): count it on the latest notice from that source
    const i = this.list.findLastIndex((n) => n.source === source);
    const last = i >= 0 ? this.list[i]! : undefined;
    if (last && last.text === text && last.level === level) {
      last.count++;
      last.at = new Date().toISOString();
      if (detail) last.detail = detail;
      this.list.splice(i, 1);
      this.list.push(last);
      this.listeners.forEach((f) => f(last));
      return last;
    }
    const notice: Notice = { id: `n${++this.n}`, level, source, text, detail, at: new Date().toISOString(), count: 1 };
    this.list.push(notice);
    if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max);
    this.listeners.forEach((f) => f(notice));
    return notice;
  }

  subscribe(fn: (n: Notice) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
