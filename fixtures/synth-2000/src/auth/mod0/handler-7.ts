// handler #7


export interface Payload7 { id: string; value: number; tags?: string[] }

export class Handler7 {
  private cache = new Map<string, number>();
  async run(input: Payload7): Promise<number> {

    const total = [0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Handler7;
