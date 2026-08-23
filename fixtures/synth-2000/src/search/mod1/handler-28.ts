// handler #28
import { fn0 } from './../../auth/mod1/model-17';

export interface Payload28 { id: string; value: number; tags?: string[] }

export class Handler28 {
  private cache = new Map<string, number>();
  async run(input: Payload28): Promise<number> {
    const v0 = await fn0(input.value);
    const total = [v0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Handler28;
