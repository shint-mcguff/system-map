// handler #4


export interface Payload4 { id: string; value: number; tags?: string[] }

export class Handler4 {
  private cache = new Map<string, number>();
  async run(input: Payload4): Promise<number> {

    const total = [0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Handler4;
