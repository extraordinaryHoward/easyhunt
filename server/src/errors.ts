export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export function required(condition: unknown, code = 'INVALID_REQUEST', message = 'Invalid request'): asserts condition { if (!condition) throw new ApiError(400, code, message); }
