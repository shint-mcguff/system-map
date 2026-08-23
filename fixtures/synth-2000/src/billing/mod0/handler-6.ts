// handler #6


export interface Payload6 { id: string; value: number; tags?: string[] }

export class Handler6 {
  private cache = new Map<string, number>();
  async run(input: Payload6): Promise<number> {

    const total = [0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Handler6;
