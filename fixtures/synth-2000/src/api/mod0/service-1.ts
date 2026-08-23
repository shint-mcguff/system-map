// service #1


export interface Payload1 { id: string; value: number; tags?: string[] }

export class Service1 {
  private cache = new Map<string, number>();
  async run(input: Payload1): Promise<number> {

    const total = [0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Service1;
