import type { Express } from 'express';
import type { PreviewComment } from '@open-design/contracts';
import { projectKindFromMetadataToTrackingOrLegacyDefault } from '@open-design/contracts/analytics';
import type { RouteDeps } from '../../server-context.js';
import { getProject, isProjectCommentAnchorConversationId } from '../../db.js';

/**
 * 本地预览评论路由。
 *
 * 这里曾是整条云协作链路上门禁最重的一处：工作区成员身份、作者归属、
 * 项目归属、以及把评论中继到 collab-cloud 的回调层层叠加。官方账号
 * （AMR/Vela）体系与 Team 工作区分区移除后，评论退化为纯粹的本机 CRUD：
 *
 * - 不再做工作区/成员身份校验，命中即写；
 * - 不再按作者或项目 owner 限制状态流转与删除；
 * - 不再有中继出站（onCommentCreated/Updated/Deleted）与远端评论拉取；
 * - 写入时若评论已有 `authorMemberId`，原样保留，避免编辑把历史作者抹掉。
 *
 * 数据库表结构与既有迁移保持不变（本 fork 不写删表迁移），因此旧库里的
 * 评论数据仍可原样读取。
 */
export interface RegisterProjectCommentRoutesDeps extends RouteDeps<'db' | 'projectStore' | 'conversations'> {
  /** Optional in focused CRUD fixtures; production supplies request-scoped analytics. */
  telemetry?: RouteDeps<'telemetry'>['telemetry'];
}

export function registerProjectCommentRoutes(app: Express, ctx: RegisterProjectCommentRoutesDeps): void {
  const { db } = ctx;
  const { updateProject } = ctx.projectStore;
  const {
    getConversation,
    listPreviewComments,
    upsertPreviewComment,
    getPreviewComment,
    updatePreviewCommentStatus,
    updatePreviewCommentAnchor,
    deletePreviewComment,
    reorderPreviewComment,
  } = ctx.conversations;
  const getRoutableConversation = (projectId: string, conversationId: string) => {
    if (isProjectCommentAnchorConversationId(conversationId)) return null;
    const conversation = getConversation(db, conversationId);
    return conversation?.projectId === projectId ? conversation : null;
  };

  // ---- Preview comments ----------------------------------------------------

  app.get('/api/projects/:id/conversations/:cid/comments', async (req, res) => {
    const conv = getRoutableConversation(req.params.id, req.params.cid);
    if (!conv) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({
      comments: listPreviewComments(db, req.params.id, req.params.cid),
    });
  });

  app.post('/api/projects/:id/conversations/:cid/comments', async (req, res) => {
    const conv = getRoutableConversation(req.params.id, req.params.cid);
    if (!conv) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    try {
      // New comments do not use a natural element key; editing requires an id.
      const body = { ...(req.body || {}) };
      const requestedId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
      let existing: PreviewComment | null = null;
      if (requestedId) {
        existing = getPreviewComment(
          db,
          req.params.id,
          req.params.cid,
          requestedId,
        ) as PreviewComment | null;
        if (!existing) {
          return res.status(404).json({ error: 'comment not found' });
        }
        // 本地不再有成员身份可供盖章，但历史行上的作者必须原样保留：
        // 否则一次普通的正文编辑会把热区里的作者抹成匿名。
        const existingAuthor = existing.authorMemberId ?? null;
        if (existingAuthor) body.authorMemberId = existingAuthor;
      }
      const targetConversationId = requestedId
        ? existing?.conversationId ?? req.params.cid
        : req.params.cid;
      const comment = db.transaction(() => {
        const saved = upsertPreviewComment(db, req.params.id, targetConversationId, body);
        updateProject(db, req.params.id, {});
        return saved;
      })();
      // Only a genuinely new, successfully persisted comment is counted.
      // Edits reuse this POST route with an id and must not inflate creation.
      if (comment && !requestedId) {
        const project = getProject(db, req.params.id);
        void ctx.telemetry?.captureProductEvent?.(
          req,
          'project_comment_create_result',
          {
            page_name: 'artifact',
            area: 'comments',
            result: 'success',
            // 单机模式没有工作区身份，作者与项目归属关系无从判定。
            target_project_relation: 'unknown',
            comment_level: 'top_level',
            project_id: req.params.id,
            project_kind: projectKindFromMetadataToTrackingOrLegacyDefault(project?.metadata),
          },
        );
      }
      res.json({ comment });
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      try {
        const existing = getPreviewComment(
          db,
          req.params.id,
          req.params.cid,
          req.params.commentId,
        ) as PreviewComment | null;
        if (!existing) return res.status(404).json({ error: 'comment not found' });
        const comment = db.transaction(() => {
          const saved = updatePreviewCommentStatus(
            db,
            req.params.id,
            existing.conversationId,
            req.params.commentId,
            req.body?.status,
          );
          if (!saved) return null;
          updateProject(db, req.params.id, {});
          return saved;
        })();
        if (!comment)
          return res.status(404).json({ error: 'comment not found' });
        res.json({ comment });
      } catch (err: any) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId/anchor',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      try {
        // Drift-ladder write-back: the client resolves anchor state each render
        // and reports it here. This is a per-daemon DERIVED read-back (each
        // daemon anchors against its own content), not a user edit, so it does
        // not bump updated_at.
        const existing = getPreviewComment(
          db,
          req.params.id,
          req.params.cid,
          req.params.commentId,
        ) as PreviewComment | null;
        if (!existing) return res.status(404).json({ error: 'comment not found' });
        const comment = updatePreviewCommentAnchor(
          db,
          req.params.id,
          existing.conversationId,
          req.params.commentId,
          req.body || {},
        );
        if (!comment) return res.status(404).json({ error: 'comment not found' });
        res.json({ comment });
      } catch (err: any) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId/reorder',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const sortKey = Number(req.body?.sortKey);
      if (!Number.isFinite(sortKey)) {
        return res.status(400).json({ error: 'sortKey must be a finite number' });
      }
      try {
        // Sidebar display order is a per-daemon viewing preference, not a
        // content edit: it does not bump updated_at. See PreviewComment.sortKey.
        const existing = getPreviewComment(
          db,
          req.params.id,
          req.params.cid,
          req.params.commentId,
        ) as PreviewComment | null;
        if (!existing) return res.status(404).json({ error: 'comment not found' });
        const comment = reorderPreviewComment(
          db,
          req.params.id,
          existing.conversationId,
          req.params.commentId,
          sortKey,
        );
        if (!comment) return res.status(404).json({ error: 'comment not found' });
        res.json({ comment });
      } catch (err: any) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.delete(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const existing = getPreviewComment(
        db,
        req.params.id,
        req.params.cid,
        req.params.commentId,
      ) as PreviewComment | null;
      if (!existing) return res.status(404).json({ error: 'comment not found' });
      let ok = false;
      try {
        ok = db.transaction(() => {
          const deleted = deletePreviewComment(
            db,
            req.params.id,
            existing.conversationId,
            req.params.commentId,
          );
          if (!deleted) return false;
          updateProject(db, req.params.id, {});
          return true;
        })();
      } catch (err: any) {
        return res.status(400).json({ error: String(err?.message || err) });
      }
      if (!ok) return res.status(404).json({ error: 'comment not found' });
      res.json({ ok: true });
    },
  );
}
