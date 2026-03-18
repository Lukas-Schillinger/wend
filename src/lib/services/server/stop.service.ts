import type { Location } from '$lib/schemas/location';
import type {
	CreateStop,
	ReorderStops,
	Stop,
	StopWithLocation,
	UpdateStop
} from '$lib/schemas/stop';
import { db } from '$lib/server/db';
import { locations, maps, stops } from '$lib/server/db/schema';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import { ServiceError } from './errors';
import { locationService } from './location.service';
import { routeService } from './route.service';

export type StopCoordinate = {
	map_id: string;
	driver_id: string | null;
	lat: number;
	lon: number;
};

export class StopService {
	async getStops(organizationId: string): Promise<Stop[]> {
		const results = await db
			.select()
			.from(stops)
			.where(eq(stops.organization_id, organizationId));
		return results;
	}

	async getStopsWithLocation(
		organizationId: string
	): Promise<StopWithLocation[]> {
		const results = await db
			.select({
				stop: stops,
				location: locations
			})
			.from(stops)
			.innerJoin(locations, eq(stops.location_id, locations.id))
			.where(eq(stops.organization_id, organizationId));

		return results;
	}

	/**
	 * Get lightweight coordinates for all stops in an organization.
	 * Used by the map list page for Mapbox static map pins.
	 */
	async getStopCoordinates(organizationId: string): Promise<StopCoordinate[]> {
		const results = await db
			.select({
				map_id: stops.map_id,
				driver_id: stops.driver_id,
				lat: locations.lat,
				lon: locations.lon
			})
			.from(stops)
			.innerJoin(locations, eq(stops.location_id, locations.id))
			.where(eq(stops.organization_id, organizationId));

		return results.map((r) => ({
			map_id: r.map_id,
			driver_id: r.driver_id,
			lat: Number(r.lat),
			lon: Number(r.lon)
		}));
	}

	/**
	 * Get the number of stops for a map (lightweight count query)
	 */
	async getStopCountForMap(
		mapId: string,
		organizationId: string
	): Promise<number> {
		const [result] = await db
			.select({ count: count() })
			.from(stops)
			.where(
				and(eq(stops.map_id, mapId), eq(stops.organization_id, organizationId))
			);

		return result.count;
	}

	/**
	 * Get all stops for a map with location details
	 */
	async getStopsByMap(
		mapId: string,
		organizationId: string,
		driverId?: string
	): Promise<StopWithLocation[]> {
		// Verify map ownership first
		const [map] = await db
			.select()
			.from(maps)
			.where(and(eq(maps.id, mapId), eq(maps.organization_id, organizationId)))
			.limit(1);

		if (!map) {
			throw ServiceError.notFound('Map not found');
		}

		const conditions = driverId
			? and(
					eq(stops.map_id, mapId),
					eq(stops.driver_id, driverId),
					eq(stops.organization_id, organizationId)
				)
			: and(eq(stops.map_id, mapId), eq(stops.organization_id, organizationId));

		const results = await db
			.select({
				stop: stops,
				location: locations
			})
			.from(stops)
			.innerJoin(locations, eq(stops.location_id, locations.id))
			.where(conditions);

		return results;
	}

	/**
	 * Get routed stops for a specific driver on a map
	 * Only returns stops with a delivery_index (assigned to route)
	 */
	async getStopsForRoute(
		mapId: string,
		driverId: string,
		organizationId: string
	): Promise<StopWithLocation[]> {
		const results = await db
			.select({
				stop: stops,
				location: locations
			})
			.from(stops)
			.innerJoin(locations, eq(stops.location_id, locations.id))
			.where(
				and(
					eq(stops.map_id, mapId),
					eq(stops.driver_id, driverId),
					eq(stops.organization_id, organizationId),
					isNotNull(stops.delivery_index)
				)
			);

		return results;
	}

	/**
	 * Get a single stop with location details
	 */
	async getStopById(
		stopId: string,
		organizationId: string
	): Promise<StopWithLocation> {
		const [result] = await db
			.select({
				stop: stops,
				location: locations
			})
			.from(stops)
			.innerJoin(locations, eq(stops.location_id, locations.id))
			.where(
				and(eq(stops.id, stopId), eq(stops.organization_id, organizationId))
			)
			.limit(1);

		if (!result) {
			throw ServiceError.notFound('Stop not found');
		}

		return result;
	}

	/**
	 * Create a new stop
	 * Can create location first if location data is provided
	 */
	async createStop(
		data: CreateStop,
		organizationId: string,
		userId: string
	): Promise<StopWithLocation> {
		let location: Location | undefined;

		// Create location if data is provided
		if (data.location && !data.location_id) {
			location = await locationService.createLocation(
				data.location,
				organizationId,
				userId
			);
		}

		const locationId = location?.id ?? data.location_id;

		if (!locationId) {
			throw ServiceError.validation(
				'Either location_id or location data must be provided'
			);
		}

		if (!location) {
			location = await locationService.getLocationById(
				locationId,
				organizationId
			);
		}

		// Verify map ownership
		const [map] = await db
			.select()
			.from(maps)
			.where(
				and(eq(maps.id, data.map_id), eq(maps.organization_id, organizationId))
			)
			.limit(1);

		if (!map) {
			throw ServiceError.notFound('Map not found');
		}

		const [stop] = await db
			.insert(stops)
			.values({
				organization_id: organizationId,
				created_by: userId,
				updated_by: userId,
				map_id: data.map_id,
				location_id: locationId,
				contact_name: data.contact_name ?? null,
				contact_phone: data.contact_phone ?? null,
				notes: data.notes ?? null,
				driver_id: data.driver_id ?? null,
				delivery_index: data.delivery_index ?? null
			})
			.returning();

		return { stop, location };
	}

	async updateStop(
		stopId: string,
		data: UpdateStop,
		organizationId: string,
		userId: string
	): Promise<StopWithLocation> {
		const { stop, location: existingLocation } = await this.getStopById(
			stopId,
			organizationId
		);

		const oldDriverId = stop.driver_id;
		const driverChanged = 'driver_id' in data && data.driver_id !== oldDriverId;

		let locationId = stop.location_id;
		let location = existingLocation;
		let locationChanged = false;

		if (data.location) {
			location = await locationService.createLocation(
				data.location,
				organizationId,
				userId
			);
			locationId = location.id;
			locationChanged = true;
		} else if (data.location_id && data.location_id !== stop.location_id) {
			location = await locationService.getLocationById(
				data.location_id,
				organizationId
			);
			locationId = data.location_id;
			locationChanged = true;
		}

		const [updatedStop] = await db
			.update(stops)
			.set({
				location_id: locationId,
				driver_id: 'driver_id' in data ? data.driver_id : stop.driver_id,
				delivery_index:
					'delivery_index' in data ? data.delivery_index : stop.delivery_index,
				contact_name:
					'contact_name' in data ? data.contact_name : stop.contact_name,
				contact_phone:
					'contact_phone' in data ? data.contact_phone : stop.contact_phone,
				notes: 'notes' in data ? data.notes : stop.notes,
				updated_by: userId
			})
			.where(eq(stops.id, stopId))
			.returning();

		if (locationChanged || driverChanged) {
			const newDriverId = updatedStop.driver_id;

			if (oldDriverId) {
				await routeService.recalculateRouteForDriver(
					stop.map_id,
					oldDriverId,
					organizationId
				);
			}

			if (newDriverId && newDriverId !== oldDriverId) {
				await routeService.recalculateRouteForDriver(
					stop.map_id,
					newDriverId,
					organizationId
				);
			}
		}

		return { stop: updatedStop, location };
	}

	/**
	 * Delete a stop
	 * If the stop was assigned to a driver, triggers route recalculation
	 */
	async deleteStop(
		stopId: string,
		organizationId: string
	): Promise<{ success: true }> {
		const { stop } = await this.getStopById(stopId, organizationId);

		// Capture assignment info before deletion
		const { driver_id, map_id } = stop;

		await db
			.delete(stops)
			.where(
				and(eq(stops.id, stopId), eq(stops.organization_id, organizationId))
			);

		// Trigger route recalculation if stop was assigned to a driver
		if (driver_id) {
			await routeService.recalculateRouteForDriver(
				map_id,
				driver_id,
				organizationId
			);
		}

		return { success: true };
	}

	/**
	 * Bulk reorder stops - update driver assignments and delivery indices.
	 * Recalculates routes for all affected drivers.
	 */
	async reorderStops(
		mapId: string,
		updates: ReorderStops['updates'],
		organizationId: string,
		userId: string
	): Promise<StopWithLocation[]> {
		if (updates.length === 0) {
			return [];
		}

		const existingStops = await db
			.select()
			.from(stops)
			.where(
				and(eq(stops.map_id, mapId), eq(stops.organization_id, organizationId))
			);

		const existingStopIds = new Set(existingStops.map((s) => s.id));
		const invalidStops = updates
			.map((u) => u.stop_id)
			.filter((id) => !existingStopIds.has(id));

		if (invalidStops.length > 0) {
			throw ServiceError.validation(
				`Stops not found in map: ${invalidStops.join(', ')}`
			);
		}

		// Collect driver IDs from both the current and new assignments
		const stopById = new Map(existingStops.map((s) => [s.id, s]));
		const affectedDriverIds = new Set<string>();
		for (const update of updates) {
			if (update.driver_id) affectedDriverIds.add(update.driver_id);
			const currentDriverId = stopById.get(update.stop_id)?.driver_id;
			if (currentDriverId) affectedDriverIds.add(currentDriverId);
		}

		const now = new Date();
		await db.transaction(async (tx) => {
			for (const update of updates) {
				await tx
					.update(stops)
					.set({
						driver_id: update.driver_id,
						delivery_index: update.delivery_index,
						updated_at: now,
						updated_by: userId
					})
					.where(eq(stops.id, update.stop_id));
			}
		});

		// TODO: Re-enable route recalculation after DnD testing
		// await Promise.all(
		// 	[...affectedDriverIds].map((driverId) =>
		// 		routeService.recalculateRouteForDriver(
		// 			mapId,
		// 			driverId,
		// 			organizationId,
		// 			userId
		// 		)
		// 	)
		// );

		return this.getStopsByMap(mapId, organizationId);
	}

	/**
	 * Unfortunately the createStops endpoint does a lot of db calls which makes this method inefficient.
	 */
	async bulkCreateStops(
		stopsData: Array<Omit<CreateStop, 'map_id'>>,
		mapId: string,
		organizationId: string,
		userId: string
	) {
		// Verify map ownership
		const [map] = await db
			.select()
			.from(maps)
			.where(and(eq(maps.id, mapId), eq(maps.organization_id, organizationId)))
			.limit(1);

		if (!map) {
			throw ServiceError.notFound('Map not found');
		}

		return await Promise.all(
			stopsData.map((stop) =>
				this.createStop({ ...stop, map_id: mapId }, organizationId, userId)
			)
		);
	}
}

// Singleton instance
export const stopService = new StopService();
