// service #2


export interface Payload2 { id: string; value: number; tags?: string[] }

export class Service2 {
  private cache = new Map<string, number>();
  async run(input: Payload2): Promise<number> {

    const total = [0].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default Service2;
