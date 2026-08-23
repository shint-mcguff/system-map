// util #13
import { fn0 } from './../../shared/mod0/handler-4';

export interface Payload13 { id: string; value: number; tags?: string[] }

export class Util13 {
  private cache = new Map<string, number>();
  async run(input: Payload13): Promise<number> {
    const v0 = await fn0(input.value);
    const total = [v0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Util13;
