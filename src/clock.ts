export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  private current: Date;
  constructor(iso: string | Date) {
    this.current = new Date(iso);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(iso: string | Date): void {
    this.current = new Date(iso);
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86400_000);
  }
}

export type IdGen = () => string;

export function uuidGen(): IdGen {
  return () => crypto.randomUUID();
}

export function seqGen(prefix = "id"): IdGen {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
