// component #9


export interface Payload9 { id: string; value: number; tags?: string[] }

export class Component9 {
  private cache = new Map<string, number>();
  async run(input: Payload9): Promise<number> {

    const total = [0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Component9;
