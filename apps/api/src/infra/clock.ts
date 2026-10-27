/** Injectable clock (NFR-TST-003): every "now" in the API comes from here. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now() {
    return new Date(this.current);
  }
  set(d: Date | string) {
    this.current = new Date(d);
  }
  advanceMinutes(min: number) {
    this.current = new Date(this.current.getTime() + min * 60_000);
  }
}
