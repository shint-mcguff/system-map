// service #3


export interface Payload3 { id: string; value: number; tags?: string[] }

export class Service3 {
  private cache = new Map<string, number>();
  async run(input: Payload3): Promise<number> {

    const total = [0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Service3;
