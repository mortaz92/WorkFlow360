import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app';

const app = createApp();

describe('GET /api/v1/health', () => {
  it('risponde con status ok', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('rotta inesistente', () => {
  it('risponde 404 con il formato errore standard', async () => {
    const res = await request(app).get('/api/v1/non-esiste');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});
