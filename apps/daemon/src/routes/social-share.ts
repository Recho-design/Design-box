import type { Express } from 'express';
import {
  buildSocialSharePayload,
  normalizeSocialShareUrl,
  type SocialShareRequest,
} from '@open-design/contracts';
import type { RouteDeps } from '../server-context.js';

export interface RegisterSocialShareRoutesDeps extends RouteDeps<'http'> {}

export function registerSocialShareRoutes(
  app: Express,
  ctx: RegisterSocialShareRoutesDeps,
) {
  const { sendApiError } = ctx.http;

  app.post('/api/social-share', (req, res) => {
    const body = (req.body ?? {}) as Partial<SocialShareRequest>;
    // Only a deployed project URL is shareable. The former repo-promo kind was
    // removed with the upstream project's promotional surface.
    if (body.kind !== 'project-html') {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'social share kind must be project-html',
      );
    }
    if (!normalizeSocialShareUrl(body.url)) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'project-html social share requires an http(s) url',
      );
    }

    res.json(buildSocialSharePayload({ ...body, kind: 'project-html' }));
  });
}
