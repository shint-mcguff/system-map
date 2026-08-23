// component #33
import { fn0 } from './../../auth/mod1/model-17';
import { fn1 } from '@/src/api/mod0/service-1';

export interface Payload33 { id: string; value: number; tags?: string[] }

export class Component33 {
  private cache = new Map<string, number>();
  async run(input: Payload33): Promise<number> {
    const v0 = await fn0(input.value);
    const v1 = await fn1(input.value);
    const total = [v0, v1].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Component33;
