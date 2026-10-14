import { ApiError } from '../../../shared/api/index.ts';

export function invalidStream(message: string, logId: string | null = null): ApiError { return new ApiError('protocol', 'invalid_mirroring_stream', message, null, logId); }
