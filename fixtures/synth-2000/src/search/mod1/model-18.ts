// model #18
import { fn0 } from './../../auth/mod1/model-17';
import { fn1 } from '@/src/billing/mod1/model-16';

export interface Payload18 { id: string; value: number; tags?: string[] }

export class Model18 {
  private cache = new Map<string, number>();
  async run(input: Payload18): Promise<number> {
    const v0 = await fn0(input.value);
    const v1 = await fn1(input.value);
    const total = [v0, v1].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Model18;
