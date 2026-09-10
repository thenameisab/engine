import { describe, expect, it } from 'vitest';
import { createEmailSender, isEmailConfigured } from './email.js';

describe('email transport (Resend)', () => {
  const env = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Engine <login@example.com>' };

  it('is unconfigured until both values are present', () => {
    expect(isEmailConfigured({})).toBe(false);
    expect(isEmailConfigured({ RESEND_API_KEY: 're_test' })).toBe(false);
    expect(isEmailConfigured({ EMAIL_FROM: 'a <a@b.c>' })).toBe(false);
    expect(isEmailConfigured(env)).toBe(true);
    expect(createEmailSender({})).toBeNull();
  });

  it('posts one message to Resend with the bearer key and the configured From', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    }) as typeof fetch;

    const sender = createEmailSender(env, fetchImpl)!;
    const result = await sender.send({ to: 'ada@example.com', subject: 'Your code', text: '123456' });

    expect(result).toEqual({ id: 'msg_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      from: 'Engine <login@example.com>',
      to: ['ada@example.com'],
      subject: 'Your code',
      text: '123456',
    });
  });

  it("surfaces Resend's own reason when a send is refused", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'The example.com domain is not verified.' }), {
        status: 403,
      })) as typeof fetch;
    const sender = createEmailSender(env, fetchImpl)!;
    await expect(sender.send({ to: 'ada@example.com', subject: 's', text: 't' })).rejects.toThrow(
      'email send failed: 403 validation_error The example.com domain is not verified.',
    );
  });
});
