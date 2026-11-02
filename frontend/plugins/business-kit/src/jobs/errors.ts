import type { TaskRecord } from './types.ts';
import { JobFailure as PublicJobFailure, JobWaitFailure as PublicJobWaitFailure } from '@deviceforge/plugin-sdk';

export const JobFailure = PublicJobFailure<TaskRecord>;
export type JobFailure = PublicJobFailure<TaskRecord>;
export const JobWaitFailure = PublicJobWaitFailure<TaskRecord>;
export type JobWaitFailure = PublicJobWaitFailure<TaskRecord>;
