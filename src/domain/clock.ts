export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** 测试注入时钟；可手动推进，不依赖真实等待。 */
export class FakeClock implements Clock {
  private current: Date;
  constructor(start: Date | string = "2026-01-05T00:00:00Z") {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }
  set(date: Date | string): Date {
    this.current = new Date(date);
    return this.now();
  }
}

export function toIso(d: Date): string {
  return d.toISOString();
}

/** 从时间戳取 UTC 业务日期。 */
export function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}
