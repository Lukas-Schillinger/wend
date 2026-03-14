import { db } from '$lib/server/db';
import { mailRecords, organizations, routeShares } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeShareService } from './route-share.service';
import { TokenUtils } from './token.utils';
import {
	createBillingTestEnvironment,
	createDepot,
	createDriver,
	createLocation,
	createMap,
	createRoute,
	createRouteShare,
	createTestEnvironment,
	withTestTransaction
} from '$lib/testing';

// vi.mock is hoisted above imports, so we inline the mock shape here.
// Shape matches createMockMailService() from $lib/testing/mocks.
const mockMailService = vi.hoisted(() => ({
	sendRouteShareEmail: vi.fn(),
	sendLoginEmail: vi.fn(),
	sendInvitationEmail: vi.fn(),
	sendPasswordResetEmail: vi.fn()
}));

vi.mock('$lib/services/server/mail.service', () => ({
	mailService: mockMailService
}));

beforeEach(() => {
	vi.clearAllMocks();
});

/**
 * Route Share Service Tests
 *
 * Uses withTestTransaction for automatic rollback - no manual cleanup needed.
 */

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

/** Helper to create full test environment with Pro plan for fleet_management feature */
async function createProRouteEnvironment() {
	const { organization, user } = await createBillingTestEnvironment();

	await db
		.update(organizations)
		.set({ subscription_status: 'active' })
		.where(eq(organizations.id, organization.id));

	const location = await createLocation({ organization_id: organization.id });
	const depot = await createDepot({
		organization_id: organization.id,
		location_id: location.id
	});
	const map = await createMap({ organization_id: organization.id });
	const driver = await createDriver({
		organization_id: organization.id,
		active: true
	});
	const route = await createRoute({
		organization_id: organization.id,
		map_id: map.id,
		driver_id: driver.id,
		depot_id: depot.id
	});

	return { organization, user, location, depot, map, driver, route };
}

/** Helper to create a share with a linked mail record (for resend tests) */
async function createShareWithMailRecord(
	organizationId: string,
	routeId: string,
	recipientEmail = 'recipient@example.com'
) {
	const share = await createRouteShare({
		organization_id: organizationId,
		route_id: routeId
	});

	const [mailRecord] = await db
		.insert(mailRecords)
		.values({
			organization_id: organizationId,
			resend_id: `mock-resend-${Date.now()}`,
			type: 'route_share',
			to_email: recipientEmail,
			from_email: 'noreply@test.com',
			subject: 'Route shared'
		})
		.returning();

	await db
		.update(routeShares)
		.set({ mail_record_id: mailRecord.id })
		.where(eq(routeShares.id, share.id));

	return { share, mailRecord };
}

describe('RouteShareService', () => {
	// ============================================================================
	// createEmailShare
	// ============================================================================
	describe('createEmailShare()', () => {
		it('returns share record and raw token', async () => {
			await withTestTransaction(async () => {
				const { organization, user, route } = await createProRouteEnvironment();

				const result = await routeShareService.createEmailShare(
					route.id,
					'recipient@example.com',
					organization.id,
					user.id
				);

				expect(result.share).toBeDefined();
				expect(result.share.id).toBeDefined();
				expect(result.share.route_id).toBe(route.id);
				expect(result.share.organization_id).toBe(organization.id);
				expect(result.share.created_by).toBe(user.id);
				expect(result.share.share_type).toBe('email');
				expect(result.share.revoked_at).toBeNull();
				expect(result.token).toBeDefined();
				expect(typeof result.token).toBe('string');
			});
		});

		it('stores hashed token, not raw token', async () => {
			await withTestTransaction(async () => {
				const { organization, user, route } = await createProRouteEnvironment();

				const { share, token } = await routeShareService.createEmailShare(
					route.id,
					'recipient@example.com',
					organization.id,
					user.id
				);

				expect(share.access_token_hash).not.toBe(token);
				expect(share.access_token_hash).toBe(TokenUtils.hash(token));
			});
		});

		it('sets expiration in the future', async () => {
			await withTestTransaction(async () => {
				const { organization, user, route } = await createProRouteEnvironment();

				const { share } = await routeShareService.createEmailShare(
					route.id,
					'recipient@example.com',
					organization.id,
					user.id
				);

				expect(share.expires_at.getTime()).toBeGreaterThan(Date.now());
			});
		});

		it('blocks share creation for Free plan users', async () => {
			await withTestTransaction(async () => {
				const { organization, user } = await createBillingTestEnvironment();
				const location = await createLocation({
					organization_id: organization.id
				});
				const map = await createMap({ organization_id: organization.id });
				const driver = await createDriver({
					organization_id: organization.id,
					active: true
				});
				const depot = await createDepot({
					organization_id: organization.id,
					location_id: location.id
				});
				const route = await createRoute({
					organization_id: organization.id,
					map_id: map.id,
					driver_id: driver.id,
					depot_id: depot.id
				});

				await expect(
					routeShareService.createEmailShare(
						route.id,
						'test@example.com',
						organization.id,
						user.id
					)
				).rejects.toMatchObject({
					code: 'FORBIDDEN',
					message: expect.stringContaining('Pro subscription')
				});
			});
		});

		it('rejects non-existent route', async () => {
			await withTestTransaction(async () => {
				const { organization, user } = await createProRouteEnvironment();

				await expect(
					routeShareService.createEmailShare(
						NON_EXISTENT_UUID,
						'test@example.com',
						organization.id,
						user.id
					)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			});
		});
	});

	// ============================================================================
	// validateTokenAndGetRoute
	// ============================================================================
	describe('validateTokenAndGetRoute()', () => {
		it('returns route details for valid token', async () => {
			await withTestTransaction(async () => {
				const { organization, user, route } = await createProRouteEnvironment();

				const { token } = await routeShareService.createEmailShare(
					route.id,
					'recipient@example.com',
					organization.id,
					user.id
				);

				const result = await routeShareService.validateTokenAndGetRoute(token);

				expect(result).not.toBeNull();
				expect(result?.route.id).toBe(route.id);
				expect(result?.driver).toBeDefined();
				expect(result?.depot).toBeDefined();
				expect(result?.map).toBeDefined();
			});
		});

		it('returns null for expired token', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const token = TokenUtils.generateHex();
				await createRouteShare({
					organization_id: organization.id,
					route_id: route.id,
					access_token_hash: TokenUtils.hash(token),
					expires_at: new Date(Date.now() - 1000)
				});

				const result = await routeShareService.validateTokenAndGetRoute(token);
				expect(result).toBeNull();
			});
		});

		it('returns null for revoked token', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const token = TokenUtils.generateHex();
				await createRouteShare({
					organization_id: organization.id,
					route_id: route.id,
					access_token_hash: TokenUtils.hash(token),
					revoked_at: new Date()
				});

				const result = await routeShareService.validateTokenAndGetRoute(token);
				expect(result).toBeNull();
			});
		});

		it('returns null for non-existent token', async () => {
			await withTestTransaction(async () => {
				const result = await routeShareService.validateTokenAndGetRoute(
					'nonexistent_token_value'
				);
				expect(result).toBeNull();
			});
		});
	});

	// ============================================================================
	// getShare
	// ============================================================================
	describe('getShareById()', () => {
		it('returns share by id and organization', async () => {
			await withTestTransaction(async () => {
				const { organization, user, route } = await createProRouteEnvironment();

				const share = await createRouteShare({
					organization_id: organization.id,
					route_id: route.id,
					created_by: user.id
				});

				const result = await routeShareService.getShareById(
					share.id,
					organization.id
				);

				expect(result.id).toBe(share.id);
				expect(result.route_id).toBe(route.id);
				expect(result.organization_id).toBe(organization.id);
			});
		});

		it('throws NOT_FOUND for non-existent share', async () => {
			await withTestTransaction(async () => {
				const { organization } = await createProRouteEnvironment();

				await expect(
					routeShareService.getShareById(NON_EXISTENT_UUID, organization.id)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			});
		});

		it('throws NOT_FOUND when share belongs to different organization', async () => {
			await withTestTransaction(async () => {
				const env1 = await createProRouteEnvironment();
				const env2 = await createProRouteEnvironment();

				const share = await createRouteShare({
					organization_id: env1.organization.id,
					route_id: env1.route.id
				});

				await expect(
					routeShareService.getShareById(share.id, env2.organization.id)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			});
		});
	});

	// ============================================================================
	// getShareWithMailRecord
	// ============================================================================
	describe('getShareWithMailRecord()', () => {
		it('returns share with null mailRecord when none linked', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const share = await createRouteShare({
					organization_id: organization.id,
					route_id: route.id
				});

				const result = await routeShareService.getShareWithMailRecord(
					share.id,
					organization.id
				);

				expect(result.id).toBe(share.id);
				expect(result.mailRecord).toBeNull();
			});
		});

		it('returns share with mailRecord when linked', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const { share, mailRecord } = await createShareWithMailRecord(
					organization.id,
					route.id
				);

				const result = await routeShareService.getShareWithMailRecord(
					share.id,
					organization.id
				);

				expect(result.mailRecord).not.toBeNull();
				expect(result.mailRecord?.id).toBe(mailRecord.id);
				expect(result.mailRecord?.to_email).toBe('recipient@example.com');
			});
		});

		it('throws NOT_FOUND for non-existent share', async () => {
			await withTestTransaction(async () => {
				const { organization } = await createProRouteEnvironment();

				await expect(
					routeShareService.getShareWithMailRecord(
						NON_EXISTENT_UUID,
						organization.id
					)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			});
		});
	});

	// ============================================================================
	// getSharesForRoute
	// ============================================================================
	describe('getSharesForRoute()', () => {
		it('returns all shares for a route', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const share1 = await createRouteShare({
					organization_id: organization.id,
					route_id: route.id
				});
				const share2 = await createRouteShare({
					organization_id: organization.id,
					route_id: route.id
				});

				const shares = await routeShareService.getSharesForRoute(
					route.id,
					organization.id
				);

				expect(shares).toHaveLength(2);
				const shareIds = shares.map((s) => s.id);
				expect(shareIds).toContain(share1.id);
				expect(shareIds).toContain(share2.id);
			});
		});

		it('returns empty array when no shares exist', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const shares = await routeShareService.getSharesForRoute(
					route.id,
					organization.id
				);

				expect(shares).toHaveLength(0);
			});
		});

		it('includes mailRecord data when present', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const { share, mailRecord } = await createShareWithMailRecord(
					organization.id,
					route.id
				);

				const shares = await routeShareService.getSharesForRoute(
					route.id,
					organization.id
				);

				const found = shares.find((s) => s.id === share.id);
				expect(found?.mailRecord).not.toBeNull();
				expect(found?.mailRecord?.id).toBe(mailRecord.id);
			});
		});
	});

	// ============================================================================
	// setMailRecordId
	// ============================================================================
	describe('setMailRecordId()', () => {
		it('updates mail_record_id on existing share', async () => {
			await withTestTransaction(async () => {
				const { organization, user } = await createTestEnvironment();
				const location = await createLocation({
					organization_id: organization.id
				});
				const map = await createMap({ organization_id: organization.id });
				const driver = await createDriver({
					organization_id: organization.id,
					active: true
				});
				const depot = await createDepot({
					organization_id: organization.id,
					location_id: location.id,
					default_depot: true
				});
				const route = await createRoute({
					organization_id: organization.id,
					map_id: map.id,
					driver_id: driver.id,
					depot_id: depot.id
				});

				const share = await createRouteShare({
					organization_id: organization.id,
					route_id: route.id,
					created_by: user.id
				});

				const [mailRecord] = await db
					.insert(mailRecords)
					.values({
						organization_id: organization.id,
						resend_id: `test-resend-id-${Date.now()}`,
						type: 'route_share',
						to_email: 'test@example.com',
						from_email: 'noreply@example.com',
						status: 'delivered'
					})
					.returning();

				await routeShareService.setMailRecordId(share.id, mailRecord.id);

				const [updatedShare] = await db
					.select()
					.from(routeShares)
					.where(eq(routeShares.id, share.id))
					.limit(1);

				expect(updatedShare.mail_record_id).toBe(mailRecord.id);
			});
		});

		it('does not throw for non-existent shareId', async () => {
			await withTestTransaction(async () => {
				await expect(
					routeShareService.setMailRecordId(
						NON_EXISTENT_UUID,
						NON_EXISTENT_UUID
					)
				).resolves.not.toThrow();
			});
		});
	});

	// ============================================================================
	// revokeShare
	// ============================================================================
	describe('revokeShare()', () => {
		it('sets revoked_at timestamp', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const share = await createRouteShare({
					organization_id: organization.id,
					route_id: route.id
				});

				await routeShareService.revokeShare(share.id, organization.id);

				const [revokedShare] = await db
					.select()
					.from(routeShares)
					.where(eq(routeShares.id, share.id));
				expect(revokedShare.revoked_at).not.toBeNull();
			});
		});

		it('throws BAD_REQUEST when already revoked', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const share = await createRouteShare({
					organization_id: organization.id,
					route_id: route.id
				});

				await routeShareService.revokeShare(share.id, organization.id);

				await expect(
					routeShareService.revokeShare(share.id, organization.id)
				).rejects.toMatchObject({
					code: 'BAD_REQUEST',
					message: expect.stringContaining('already revoked')
				});
			});
		});

		it('throws NOT_FOUND for non-existent share', async () => {
			await withTestTransaction(async () => {
				const { organization } = await createProRouteEnvironment();

				await expect(
					routeShareService.revokeShare(NON_EXISTENT_UUID, organization.id)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			});
		});

		it('prevents cross-tenant revocation', async () => {
			await withTestTransaction(async () => {
				const env1 = await createProRouteEnvironment();
				const env2 = await createProRouteEnvironment();

				const share = await createRouteShare({
					organization_id: env1.organization.id,
					route_id: env1.route.id
				});

				await expect(
					routeShareService.revokeShare(share.id, env2.organization.id)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			});
		});
	});

	// ============================================================================
	// deleteShare
	// ============================================================================
	describe('deleteShare()', () => {
		it('removes share from database', async () => {
			await withTestTransaction(async () => {
				const { organization, route } = await createProRouteEnvironment();

				const share = await createRouteShare({
					organization_id: organization.id,
					route_id: route.id
				});

				await routeShareService.deleteShare(share.id, organization.id);

				await expect(
					routeShareService.getShareById(share.id, organization.id)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			});
		});

		it('throws NOT_FOUND for non-existent share', async () => {
			await withTestTransaction(async () => {
				const { organization } = await createProRouteEnvironment();

				await expect(
					routeShareService.deleteShare(NON_EXISTENT_UUID, organization.id)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			});
		});

		it('prevents cross-tenant deletion', async () => {
			await withTestTransaction(async () => {
				const env1 = await createProRouteEnvironment();
				const env2 = await createProRouteEnvironment();

				const share = await createRouteShare({
					organization_id: env1.organization.id,
					route_id: env1.route.id
				});

				// Should throw NOT_FOUND for cross-org access
				await expect(
					routeShareService.deleteShare(share.id, env2.organization.id)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });

				// Verify share still exists for the owning org
				const existing = await routeShareService.getShareById(
					share.id,
					env1.organization.id
				);
				expect(existing).toBeDefined();
			});
		});
	});

	// ============================================================================
	// resendEmailShare
	// ============================================================================
	describe('resendEmailShare()', () => {
		it('revokes old share and creates new one', async () => {
			await withTestTransaction(async () => {
				const { organization, user, route } = await createProRouteEnvironment();

				const { share: initialShare } = await createShareWithMailRecord(
					organization.id,
					route.id
				);

				const newShare = await routeShareService.resendEmailShare(
					initialShare.id,
					organization.id,
					user.id,
					'https://example.com'
				);

				// Old share revoked
				const oldShare = await routeShareService.getShareById(
					initialShare.id,
					organization.id
				);
				expect(oldShare.revoked_at).not.toBeNull();

				// New share is different and active
				expect(newShare.id).not.toBe(initialShare.id);
				expect(newShare.revoked_at).toBeNull();
				expect(newShare.access_token_hash).not.toBe(
					initialShare.access_token_hash
				);
			});
		});

		it('throws BAD_REQUEST when original share has no email', async () => {
			await withTestTransaction(async () => {
				const { organization, user, route } = await createProRouteEnvironment();

				// Create share directly (no mail record)
				const share = await createRouteShare({
					organization_id: organization.id,
					route_id: route.id
				});

				await expect(
					routeShareService.resendEmailShare(
						share.id,
						organization.id,
						user.id,
						'https://example.com'
					)
				).rejects.toMatchObject({
					code: 'BAD_REQUEST',
					message: expect.stringContaining('no email address')
				});
			});
		});

		it('throws NOT_FOUND for non-existent share', async () => {
			await withTestTransaction(async () => {
				const { organization, user } = await createProRouteEnvironment();

				await expect(
					routeShareService.resendEmailShare(
						NON_EXISTENT_UUID,
						organization.id,
						user.id,
						'https://example.com'
					)
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			});
		});
	});

	// ============================================================================
	// createAndSendEmailShare
	// ============================================================================
	describe('createAndSendEmailShare()', () => {
		it('creates share and calls mail service', async () => {
			await withTestTransaction(async () => {
				const { organization, user, route } = await createProRouteEnvironment();

				const result = await routeShareService.createAndSendEmailShare(
					route.id,
					'recipient@example.com',
					organization.id,
					user.id,
					'https://example.com'
				);

				expect(result.id).toBeDefined();
				expect(result.route_id).toBe(route.id);
				expect(mockMailService.sendRouteShareEmail).toHaveBeenCalledOnce();
				expect(mockMailService.sendRouteShareEmail).toHaveBeenCalledWith(
					expect.objectContaining({ route_id: route.id }),
					'recipient@example.com',
					expect.any(String),
					expect.any(String),
					expect.any(String),
					'https://example.com'
				);
			});
		});

		it('rolls back share record when email sending fails', async () => {
			await withTestTransaction(async () => {
				const { organization, user, route } = await createProRouteEnvironment();

				mockMailService.sendRouteShareEmail.mockRejectedValueOnce(
					new Error('Email provider unavailable')
				);

				await expect(
					routeShareService.createAndSendEmailShare(
						route.id,
						'recipient@example.com',
						organization.id,
						user.id,
						'https://example.com'
					)
				).rejects.toThrow('Email provider unavailable');

				// Verify no orphaned share was created
				const shares = await routeShareService.getSharesForRoute(
					route.id,
					organization.id
				);
				expect(shares).toHaveLength(0);
			});
		});

		it('blocks for Free plan users', async () => {
			await withTestTransaction(async () => {
				const { organization, user } = await createBillingTestEnvironment();
				const location = await createLocation({
					organization_id: organization.id
				});
				const map = await createMap({ organization_id: organization.id });
				const driver = await createDriver({
					organization_id: organization.id,
					active: true
				});
				const depot = await createDepot({
					organization_id: organization.id,
					location_id: location.id
				});
				const route = await createRoute({
					organization_id: organization.id,
					map_id: map.id,
					driver_id: driver.id,
					depot_id: depot.id
				});

				await expect(
					routeShareService.createAndSendEmailShare(
						route.id,
						'test@example.com',
						organization.id,
						user.id,
						'https://example.com'
					)
				).rejects.toMatchObject({
					code: 'FORBIDDEN',
					message: expect.stringContaining('Pro subscription')
				});
			});
		});
	});
});
