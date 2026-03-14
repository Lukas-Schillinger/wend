import { TOKEN_EXPIRY } from '$lib/config/constants';
import type {
	RouteShare,
	RouteShareWithMailRecord,
	RouteWithDetails
} from '$lib/schemas';
import { db, withTransaction } from '$lib/server/db';
import { mailRecords, routeShares, routes } from '$lib/server/db/schema';
import { mailService } from '$lib/services/server/mail.service.js';
import { and, eq, isNull } from 'drizzle-orm';
import { getPlanFeatures } from '$lib/config/billing';
import { billingService } from './billing.service';
import { ServiceError } from './errors';
import { routeService } from './route.service';
import { TokenUtils } from './token.utils';

export class RouteShareService {
	/**
	 * Verify the organization has the fleet_management feature enabled.
	 * Throws ServiceError.forbidden if feature is not available.
	 */
	private async requireFleetManagement(organizationId: string): Promise<void> {
		const { plan } = await billingService.getBillingInfo(organizationId);
		const features = getPlanFeatures(plan);

		if (!features.fleet_management) {
			throw ServiceError.forbidden(
				'Route sharing requires a Pro subscription. Please upgrade to share routes with drivers.'
			);
		}
	}

	/**
	 * Create an email share for a route
	 * Returns the share record and the raw token (to be included in the email link)
	 */
	async createEmailShare(
		routeId: string,
		recipientEmail: string,
		organizationId: string,
		createdBy: string
	): Promise<{ share: RouteShare; token: string }> {
		// Check fleet_management feature is enabled
		await this.requireFleetManagement(organizationId);

		// Verify the route exists and belongs to the organization
		await routeService.getRouteById(routeId, organizationId);

		const token = TokenUtils.generateHex();
		const tokenHash = TokenUtils.hash(token);

		const [share] = await db
			.insert(routeShares)
			.values({
				organization_id: organizationId,
				route_id: routeId,
				created_by: createdBy,
				share_type: 'email',
				access_token_hash: tokenHash,
				expires_at: TokenUtils.getExpiry(TOKEN_EXPIRY.SHARE_HOURS)
			})
			.returning();

		return { share: share as RouteShare, token };
	}

	/**
	 * Link a mail record to a share (called after sending email)
	 */
	async setMailRecordId(shareId: string, mailRecordId: string): Promise<void> {
		await db
			.update(routeShares)
			.set({ mail_record_id: mailRecordId })
			.where(eq(routeShares.id, shareId));
	}

	/**
	 * Validate a share token and return the route with details if valid
	 * Returns null if token is invalid, expired, or revoked
	 */
	async validateTokenAndGetRoute(
		token: string
	): Promise<RouteWithDetails | null> {
		const tokenHash = TokenUtils.hash(token);

		const [result] = await db
			.select({ share: routeShares, route: routes })
			.from(routeShares)
			.innerJoin(routes, eq(routeShares.route_id, routes.id))
			.where(
				and(
					eq(routeShares.access_token_hash, tokenHash),
					isNull(routeShares.revoked_at)
				)
			)
			.limit(1);

		if (!result) {
			return null;
		}

		const share = result.share;

		// Check expiration
		if (TokenUtils.isExpired(share.expires_at)) {
			return null;
		}

		// Get full route details
		return routeService.getRouteWithDetails(
			share.route_id,
			share.organization_id
		);
	}

	/**
	 * Get all shares for a route with their mail records
	 */
	async getSharesForRoute(
		routeId: string,
		organizationId: string
	): Promise<RouteShareWithMailRecord[]> {
		await routeService.getRouteById(routeId, organizationId);

		const results = await db
			.select({ share: routeShares, mailRecord: mailRecords })
			.from(routeShares)
			.leftJoin(mailRecords, eq(routeShares.mail_record_id, mailRecords.id))
			.where(
				and(
					eq(routeShares.route_id, routeId),
					eq(routeShares.organization_id, organizationId)
				)
			);

		return results.map((r) => ({
			...r.share,
			mailRecord: r.mailRecord
		})) as RouteShareWithMailRecord[];
	}

	/**
	 * Get a single share by ID
	 */
	async getShareById(
		shareId: string,
		organizationId: string
	): Promise<RouteShare> {
		const [share] = await db
			.select()
			.from(routeShares)
			.where(
				and(
					eq(routeShares.id, shareId),
					eq(routeShares.organization_id, organizationId)
				)
			)
			.limit(1);

		if (!share) {
			throw ServiceError.notFound('Share not found');
		}

		return share as RouteShare;
	}

	/**
	 * Get a single share with its mail record
	 */
	async getShareWithMailRecord(
		shareId: string,
		organizationId: string
	): Promise<RouteShareWithMailRecord> {
		const [result] = await db
			.select({ share: routeShares, mailRecord: mailRecords })
			.from(routeShares)
			.leftJoin(mailRecords, eq(routeShares.mail_record_id, mailRecords.id))
			.where(
				and(
					eq(routeShares.id, shareId),
					eq(routeShares.organization_id, organizationId)
				)
			)
			.limit(1);

		if (!result) {
			throw ServiceError.notFound('Share not found');
		}

		return {
			...result.share,
			mailRecord: result.mailRecord
		} as RouteShareWithMailRecord;
	}

	/**
	 * Get mail record for a share (internal helper)
	 */
	private async getMailRecordForShare(
		shareId: string
	): Promise<{ to_email: string } | null> {
		const [result] = await db
			.select({ mailRecord: mailRecords })
			.from(routeShares)
			.leftJoin(mailRecords, eq(routeShares.mail_record_id, mailRecords.id))
			.where(eq(routeShares.id, shareId))
			.limit(1);

		return result?.mailRecord ?? null;
	}

	/**
	 * Revoke a share
	 */
	async revokeShare(shareId: string, organizationId: string): Promise<void> {
		const share = await this.getShareById(shareId, organizationId);

		if (share.revoked_at) {
			throw ServiceError.badRequest('Share is already revoked');
		}

		await db
			.update(routeShares)
			.set({ revoked_at: new Date() })
			.where(eq(routeShares.id, shareId));
	}

	/**
	 * Resend a share email (creates new share, revokes old one)
	 * Returns the new share with mail record
	 */
	async resendEmailShare(
		shareId: string,
		organizationId: string,
		createdBy: string,
		origin: string
	): Promise<RouteShareWithMailRecord> {
		const existingShare = await this.getShareById(shareId, organizationId);
		const mailRecord = await this.getMailRecordForShare(shareId);

		if (!mailRecord?.to_email) {
			throw ServiceError.badRequest(
				'Cannot resend: no email address on original share'
			);
		}

		return withTransaction(async () => {
			if (!existingShare.revoked_at) {
				await this.revokeShare(shareId, organizationId);
			}

			return this.createAndSendEmailShare(
				existingShare.route_id,
				mailRecord.to_email,
				organizationId,
				createdBy,
				origin
			);
		});
	}

	/**
	 * Delete a share entirely
	 */
	async deleteShare(
		shareId: string,
		organizationId: string
	): Promise<{ success: true }> {
		await this.getShareById(shareId, organizationId);

		await db
			.delete(routeShares)
			.where(
				and(
					eq(routeShares.id, shareId),
					eq(routeShares.organization_id, organizationId)
				)
			);

		return { success: true };
	}

	/**
	 * Create an email share and send the notification email
	 * Returns the share with mail record for API response
	 */
	async createAndSendEmailShare(
		routeId: string,
		recipientEmail: string,
		organizationId: string,
		createdBy: string,
		origin: string
	): Promise<RouteShareWithMailRecord> {
		return withTransaction(async () => {
			const { share, token } = await this.createEmailShare(
				routeId,
				recipientEmail,
				organizationId,
				createdBy
			);

			const routeDetails = await routeService.getRouteWithDetails(
				routeId,
				organizationId
			);

			await mailService.sendRouteShareEmail(
				share,
				recipientEmail,
				token,
				routeDetails.map.title,
				routeDetails.driver.name,
				origin
			);

			return this.getShareWithMailRecord(share.id, organizationId);
		});
	}
}

export const routeShareService = new RouteShareService();
