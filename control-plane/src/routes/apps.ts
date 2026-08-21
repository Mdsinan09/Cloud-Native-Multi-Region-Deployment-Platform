/**
 * Apps Routes
 */
import { Router } from 'express';
import { pool } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';

const router = Router();

router.use(authenticateToken);

/**
 * POST /api/apps
 * Create a new app
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const { name, repoUrl, githubWebhookSecret, namespace } = req.body;

    if (!name || !repoUrl) {
      res.status(400).json({ error: 'Name and repoUrl are required' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO apps (user_id, name, repo_url, github_webhook_secret, namespace)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user.id, name, repoUrl, githubWebhookSecret || null, namespace || 'default']
    );

    res.status(201).json(result.rows[0]);
  })
);

/**
 * GET /api/apps
 * List user's apps
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const result = await pool.query(
      'SELECT * FROM apps WHERE user_id = $1 ORDER BY created_at DESC',
      [user.id]
    );
    res.json(result.rows);
  })
);

/**
 * GET /api/apps/:id
 * Get app with deployments
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const { id } = req.params;

    const appResult = await pool.query(
      'SELECT * FROM apps WHERE id = $1 AND user_id = $2',
      [id, user.id]
    );

    if (appResult.rows.length === 0) {
      res.status(404).json({ error: 'App not found' });
      return;
    }

    const deploymentsResult = await pool.query(
      `SELECT id, commit_sha, commit_message, branch, status, image_tag, region, started_at, completed_at, created_at
       FROM deployments WHERE app_id = $1 ORDER BY created_at DESC`,
      [id]
    );

    res.json({
      ...appResult.rows[0],
      deployments: deploymentsResult.rows,
    });
  })
);

export default router;
