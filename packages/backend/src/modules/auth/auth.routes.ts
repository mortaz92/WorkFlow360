import { Router } from 'express';
import ms from 'ms';
import { z } from 'zod';
import { CONFIG } from '../../core/config';
import { UnauthorizedError, ValidationError } from '../../core/errors';
import { requireAuth } from './auth.middleware';
import {
  issueRefreshToken,
  requestPasswordReset,
  resetPassword,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyCredentials,
} from './auth.service';

const REFRESH_COOKIE_NAME = 'wf360_refresh';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

// Stessa regola minima di createUserSchema (users.routes.ts): due soglie diverse per
// la stessa password sarebbero un bug che si scopre solo quando qualcuno resta fuori.
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: CONFIG.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: ms(CONFIG.JWT_REFRESH_EXPIRES_IN),
    path: REFRESH_COOKIE_PATH,
  };
}

export const authRouter = Router();

authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Email o password non validi', parsed.error.flatten().fieldErrors);
    }

    const user = await verifyCredentials(parsed.data.email, parsed.data.password);
    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
    res.json({ accessToken, user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const currentRefreshToken: unknown = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof currentRefreshToken !== 'string' || !currentRefreshToken) {
      throw new UnauthorizedError('Refresh token mancante');
    }

    const { user, refreshToken } = await rotateRefreshToken(currentRefreshToken);
    const accessToken = signAccessToken(user);

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
    res.json({ accessToken, user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const currentRefreshToken: unknown = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof currentRefreshToken === 'string' && currentRefreshToken) {
      await revokeRefreshToken(currentRefreshToken);
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Fuori da requireAuth (nessun middleware globale su questo router, solo /me ce l'ha
// inline): chi ha dimenticato la password non ha un token valido con cui autenticarsi.
// Risponde SEMPRE 200 con lo stesso corpo, esista o no l'email — l'anti-enumerazione
// vera vive in requestPasswordReset (auth.service.ts), qui si tratta solo di non
// lasciar trapelare nulla nemmeno a livello di rotta (nessun errore diverso, nessun
// codice diverso tra "email esistente" ed "email inesistente").
authRouter.post('/forgot-password', async (req, res, next) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Email non valida', parsed.error.flatten().fieldErrors);
    }
    await requestPasswordReset(parsed.data.email);
    res.json({ message: 'Se l\'indirizzo è registrato, riceverai un\'email con le istruzioni per reimpostare la password.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/reset-password', async (req, res, next) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati non validi', parsed.error.flatten().fieldErrors);
    }
    // resetPassword lancia UnauthorizedError per QUALSIASI motivo di rifiuto (token
    // inesistente, scaduto, già usato, utente disattivato) — mai un messaggio diverso
    // per ciascun caso, altrimenti diventerebbe un modo per indovinare se un token è
    // "quasi giusto".
    await resetPassword(parsed.data.token, parsed.data.password);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
