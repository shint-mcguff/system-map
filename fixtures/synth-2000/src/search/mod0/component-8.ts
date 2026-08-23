// component #8


export interface Payload8 { id: string; value: number; tags?: string[] }

export class Component8 {
  private cache = new Map<string, number>();
  async run(input: Payload8): Promise<number> {

    const total = [0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Component8;
