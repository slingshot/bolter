import { createClient, type RedisClientType } from 'redis';
import { config } from '../config';

export class RedisStorage {
  private client: RedisClientType | null = null;
  private connecting = false;

  async connect(): Promise<void> {
    if (this.client || this.connecting) return;
    this.connecting = true;

    const url = config.redisPassword
      ? `redis://${config.redisUser ? config.redisUser + ':' : ''}${config.redisPassword}@${config.redisHost}:${config.redisPort}`
      : `redis://${config.redisHost}:${config.redisPort}`;

    this.client = createClient({ url });

    this.client.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    await this.client.connect();
    this.connecting = false;
  }

  private async getClient(): Promise<RedisClientType> {
    if (!this.client) {
      await this.connect();
    }
    return this.client!;
  }

  async ping(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async hSet(key: string, field: string, value: string): Promise<void> {
    const client = await this.getClient();
    await client.hSet(key, field, value);
  }

  async hGet(key: string, field: string): Promise<string | null> {
    const client = await this.getClient();
    const result = await client.hGet(key, field);
    return result ?? null;
  }

  async hGetAll(key: string): Promise<Record<string, string> | null> {
    const client = await this.getClient();
    const result = await client.hGetAll(key);
    if (Object.keys(result).length === 0) return null;
    return result;
  }

  async hDel(key: string, ...fields: string[]): Promise<void> {
    const client = await this.getClient();
    await client.hDel(key, fields);
  }

  async expire(key: string, seconds: number): Promise<void> {
    const client = await this.getClient();
    await client.expire(key, seconds);
  }

  async del(key: string): Promise<void> {
    const client = await this.getClient();
    await client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const client = await this.getClient();
    const result = await client.exists(key);
    return result === 1;
  }

  async ttl(key: string): Promise<number> {
    const client = await this.getClient();
    return client.ttl(key);
  }

  async hIncrBy(key: string, field: string, increment: number): Promise<number> {
    const client = await this.getClient();
    return client.hIncrBy(key, field, increment);
  }
}

export const redis = new RedisStorage();
