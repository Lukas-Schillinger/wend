import { registerSchema } from '$lib/schemas/auth';
import { emailSchema, passwordSchema } from '$lib/schemas/common';
import { ServiceError } from '$lib/errors';
import { fail, redirect } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import modules that will be mocked
import { userService } from '$lib/services/server/user.service.js';
import { loginTokenService } from '$lib/services/server/login-token.service.js';
import { mailService } from '$lib/services/server/mail.service';
import { superValidate, message, setError } from 'sveltekit-superforms';

// Mock dependencies
vi.mock('$lib/server/db', () => ({
	db: {
		select: vi.fn(),
		insert: vi.fn()
	}
}));

vi.mock('$lib/services/server/auth', () => ({
	generateSessionToken: vi.fn(),
	createSession: vi.fn(),
	setSessionTokenCookie: vi.fn(),
	createUser: vi.fn()
}));

vi.mock('$lib/services/server/user.service.js', () => ({
	userService: {
		createUser: vi.fn()
	}
}));

vi.mock('$lib/services/server/login-token.service.js', () => ({
	loginTokenService: {
		createLoginToken: vi.fn()
	}
}));

vi.mock('@sveltejs/kit', () => ({
	fail: vi.fn(),
	redirect: vi.fn()
}));

vi.mock('@node-rs/argon2', () => ({
	hash: vi.fn(),
	verify: vi.fn()
}));

vi.mock('$lib/services/server/mail.service', () => ({
	mailService: {
		sendLoginEmail: vi.fn().mockResolvedValue(undefined)
	}
}));

vi.mock('sveltekit-superforms', () => ({
	superValidate: vi.fn(),
	message: vi.fn(),
	setError: vi.fn()
}));

vi.mock('sveltekit-superforms/adapters', () => ({
	zod4: vi.fn()
}));

describe('Registration Server Actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe('Validation Schemas', () => {
		describe('emailSchema', () => {
			it('should accept valid email formats', () => {
				const validEmails = [
					'test@example.com',
					'user.name@domain.co.uk',
					'test+tag@example.org',
					'123@numbers.com',
					'user-name@sub.domain.com',
					'a@b.co'
				];

				validEmails.forEach((email) => {
					expect(emailSchema.safeParse(email).success).toBe(true);
				});
			});

			it('should reject invalid email formats', () => {
				const invalidEmails = [
					'notanemail',
					'@domain.com',
					'user@',
					'user..name@domain.com',
					'user name@domain.com',
					'',
					'user@domain',
					'user@.com',
					'user@domain.',
					null,
					undefined,
					123
				];

				invalidEmails.forEach((email) => {
					expect(emailSchema.safeParse(email).success).toBe(false);
				});
			});

			it('should reject emails that are too short', () => {
				expect(emailSchema.safeParse('a@').success).toBe(false);
				expect(emailSchema.safeParse('ab').success).toBe(false);
			});

			it('should reject emails that are too long', () => {
				const longEmail = 'a'.repeat(250) + '@example.com';
				expect(emailSchema.safeParse(longEmail).success).toBe(false);
			});
		});

		describe('passwordSchema', () => {
			it('should accept valid password lengths', () => {
				const validPasswords = [
					'123456', // minimum length
					'password123',
					'complex!Password123',
					'a'.repeat(255) // maximum length
				];

				validPasswords.forEach((password) => {
					expect(passwordSchema.safeParse(password).success).toBe(true);
				});
			});

			it('should reject invalid password lengths', () => {
				const invalidPasswords = [
					'', // empty
					'12345', // too short
					'abc', // too short
					'a'.repeat(256), // too long
					null,
					undefined,
					123
				];

				invalidPasswords.forEach((password) => {
					expect(passwordSchema.safeParse(password).success).toBe(false);
				});
			});
		});

		describe('registerSchema', () => {
			it('should validate complete registration input', () => {
				const validInput = {
					email: 'test@example.com',
					password: 'password123'
				};
				expect(registerSchema.safeParse(validInput).success).toBe(true);
			});

			it('should reject invalid registration input', () => {
				const invalidInputs = [
					{ email: 'invalid', password: 'password123' },
					{ email: 'test@example.com', password: '123' },
					{ email: '', password: '' },
					{ email: 'test@example.com' }, // missing password
					{ password: 'password123' } // missing email
				];

				invalidInputs.forEach((input) => {
					expect(registerSchema.safeParse(input).success).toBe(false);
				});
			});
		});
	});

	describe('Server Actions', () => {
		const createMockEvent = () => ({
			request: new Request('http://localhost', { method: 'POST' }),
			locals: {
				user: null,
				session: null,
				log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
			},
			url: { origin: 'http://localhost:5173' }
		});

		describe('Register Action', () => {
			it('should handle successful registration', async () => {
				const { actions } = await import('./+page.server.js');

				const mockForm = {
					valid: true,
					data: { email: 'newuser@example.com', password: 'password123' }
				};
				vi.mocked(superValidate).mockResolvedValue(mockForm as never);

				// Configure redirect to throw (as SvelteKit does)
				vi.mocked(redirect).mockImplementation(() => {
					throw Object.assign(new Error('redirect'), { status: 302 });
				});

				vi.mocked(loginTokenService.createLoginToken).mockResolvedValue({
					loginToken: { id: 'token-123' },
					token: '123456'
				} as never);

				vi.mocked(mailService.sendLoginEmail).mockResolvedValue(
					undefined as never
				);

				vi.mocked(userService.createUser).mockResolvedValue({
					id: 'new-user-123',
					email: 'test@example.com',
					passwordHash: null,
					created_at: new Date(),
					created_by: null,
					updated_at: new Date(),
					updated_by: null,
					organization_id: 'org_id',
					name: null,
					role: 'member',
					email_confirmed_at: null
				});

				const mockEvent = createMockEvent();

				await expect(actions.register(mockEvent as never)).rejects.toThrow(
					'redirect'
				);
				expect(redirect).toHaveBeenCalledWith(
					302,
					'/auth/login?email=newuser%40example.com&confirm=true'
				);
			});

			it('should handle registration with invalid input', async () => {
				const { actions } = await import('./+page.server.js');

				const mockForm = { valid: false };
				vi.mocked(superValidate).mockResolvedValue(mockForm as never);
				vi.mocked(fail).mockReturnValue({ status: 400 } as never);

				const mockEvent = createMockEvent();

				await actions.register(mockEvent as never);
				expect(fail).toHaveBeenCalledWith(400, { form: mockForm });
			});

			it('should handle duplicate email ServiceError', async () => {
				const { actions } = await import('./+page.server.js');

				const mockForm = {
					valid: true,
					data: { email: 'existing@example.com', password: 'password123' }
				};
				vi.mocked(superValidate).mockResolvedValue(mockForm as never);

				vi.mocked(userService.createUser).mockRejectedValue(
					new ServiceError('Email already registered', 'CONFLICT', 409)
				);

				const mockEvent = createMockEvent();
				await actions.register(mockEvent as never);

				expect(setError).toHaveBeenCalledWith(
					mockForm,
					'email',
					'Email already registered'
				);
			});

			it('should handle unknown error during registration', async () => {
				const { actions } = await import('./+page.server.js');

				const mockForm = {
					valid: true,
					data: { email: 'test@example.com', password: 'password123' }
				};
				vi.mocked(superValidate).mockResolvedValue(mockForm as never);

				vi.mocked(userService.createUser).mockRejectedValue(
					new Error('Unknown error')
				);

				const mockEvent = createMockEvent();
				await actions.register(mockEvent as never);

				expect(message).toHaveBeenCalledWith(
					mockForm,
					'An unexpected error occurred',
					{ status: 500 }
				);
			});
		});
	});
});
