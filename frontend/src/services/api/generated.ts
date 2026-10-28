// 此文件从 Rust 公开接口模式生成，请通过 npm run generate:api 更新。
export interface paths {
    "/api/v1/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query: {

                    filename: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/octet-stream": string;
                };
            };
            responses: {

                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            filename: string;
                            id: string;
                            media_type: string;
                            sha256: string;

                            size: number;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/artifacts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            filename: string;
                            id: string;
                            media_type: string;
                            sha256: string;

                            size: number;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;

        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            filename: string;
                            id: string;
                            media_type: string;
                            sha256: string;

                            size: number;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/artifacts/{id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/msgpack": string;
                        "application/zip": string;
                        "image/png": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/artifacts/{id}/entries": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    offset?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            entries: {

                                compressed_size: number;
                                directory: boolean;
                                name: string;

                                size: number;
                            }[];

                            next_offset?: number | null;

                            total: number;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            api_version: 1;

                            status: "ok";
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            error?: string | null;
                            id: string;
                            input: unknown;
                            operation: string;
                            result?: unknown;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                        }[];
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        input: unknown;
                        operation: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            error?: string | null;
                            id: string;
                            input: unknown;
                            operation: string;
                            result?: unknown;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            error?: string | null;
                            id: string;
                            input: unknown;
                            operation: string;
                            result?: unknown;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            error?: string | null;
                            id: string;
                            input: unknown;
                            operation: string;
                            result?: unknown;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    after?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            job_id: string;
                            progress?: {

                                completed_bytes: number;
                                resource_id?: string | null;

                                stage: "preparing" | "downloading" | "verifying" | "deploying" | "activating" | "complete";

                                total_bytes?: number | null;
                            } | null;

                            sequence: number;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";

                            timestamp: number;
                        }[];
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            execution?: {

                                api_version: number;

                                source: "default" | "declared";

                                total_timeout_ms: number;
                            } | null;
                            id: string;
                            input_schema: unknown;
                            title: string;
                        }[];
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query: {

                    filename: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/octet-stream": string;
                };
            };
            responses: {

                201: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                filename: string;
                                id: string;
                                media_type: string;
                                sha256: string;

                                size: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                415: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/artifacts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                filename: string;
                                id: string;
                                media_type: string;
                                sha256: string;

                                size: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;

        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                filename: string;
                                id: string;
                                media_type: string;
                                sha256: string;

                                size: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/artifacts/{id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/msgpack": string;
                        "application/zip": string;
                        "image/png": string;
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/artifacts/{id}/entries": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    offset?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                entries: {

                                    compressed_size: number;
                                    directory: boolean;
                                    name: string;

                                    size: number;
                                }[];

                                next_offset?: number | null;

                                total: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/browser-plugin-configurations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                record: {
                                    applied: string;
                                    revision: string;
                                    sensitivePaths: string[];
                                    values: unknown;

                                    version: number;
                                } | null;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;

        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        expected_revision: string | null;
                        record: {
                            applied: string;
                            revision: string;
                            sensitivePaths: string[];
                            values: unknown;

                            version: number;
                        };
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                record: {
                                    applied: string;
                                    revision: string;
                                    sensitivePaths: string[];
                                    values: unknown;

                                    version: number;
                                } | null;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v2/browser-plugins/{id}/assets/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;

                    path: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/octet-stream": string;
                        "text/javascript": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;

        head: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;

                    path: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/octet-stream": string;
                        "text/javascript": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };
            };
        };
        patch?: never;
        trace?: never;
    };
    "/api/v2/browser-plugins/{id}/runs/{run_id}/assets/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;

                    path: string;

                    run_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/octet-stream": string;
                        "text/javascript": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;

        head: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;

                    path: string;

                    run_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/octet-stream": string;
                        "text/javascript": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };
            };
        };
        patch?: never;
        trace?: never;
    };
    "/api/v2/debugger/bridge/ack": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        command_id: string;

                        generation?: string | null;
                        instance_id: string;
                        plugin_id: string;

                        response?: unknown;
                        success: boolean;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                command_id: string;
                                session_id: string;
                                state: ("queued" | "delivered" | "succeeded" | "failed" | "cancelled_unconfirmed") | "timed_out_unconfirmed";

                                timeout_ms: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/debugger/bridge/disconnect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        instance_id: string;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            data: {
                                disconnected: boolean;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/debugger/bridge/heartbeat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        instance_id: string;

                        plugins?: {

                            generation?: string | null;
                            plugin_id: string;

                            version?: string | null;
                        }[] | null;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                active_sessions: {

                                    idle_ttl_ms: number;
                                    session_id: string;

                                    state: "active" | "closed" | "expired" | "disconnected" | "target_changed";
                                    target: {

                                        generation: string | null;

                                        instance_id: string | null;
                                        plugin_id: string;

                                        target_kind: "browser" | "server";

                                        version: string | null;
                                    };
                                }[];
                                instance_id: string;
                                targets: {

                                    generation: string | null;

                                    instance_id: string | null;
                                    plugin_id: string;

                                    target_kind: "browser" | "server";

                                    version: string | null;
                                }[];
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/debugger/bridge/poll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        instance_id: string;

                        limit?: number;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                active_sessions: {

                                    idle_ttl_ms: number;
                                    session_id: string;

                                    state: "active" | "closed" | "expired" | "disconnected" | "target_changed";
                                    target: {

                                        generation: string | null;

                                        instance_id: string | null;
                                        plugin_id: string;

                                        target_kind: "browser" | "server";

                                        version: string | null;
                                    };
                                }[];
                                commands: {
                                    command_id: string;
                                    parameters: unknown;

                                    remaining_ms: number;
                                    session_id: string;
                                    target: {

                                        generation: string | null;

                                        instance_id: string | null;
                                        plugin_id: string;

                                        target_kind: "browser" | "server";

                                        version: string | null;
                                    };

                                    tool: "inspect" | "ui_tree" | "ui_query" | "ui_diff" | "ui_assert" | "ui_action" | "invoke" | "reload" | "report";
                                }[];
                                instance_id: string;
                                targets: {

                                    generation: string | null;

                                    instance_id: string | null;
                                    plugin_id: string;

                                    target_kind: "browser" | "server";

                                    version: string | null;
                                }[];
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/debugger/bridge/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        plugins?: {

                            generation?: string | null;
                            plugin_id: string;

                            version?: string | null;
                        }[];
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                active_sessions: number;

                                idle_ttl_ms: number;
                                instance_id: string;
                                plugins: {

                                    generation: string | null;
                                    plugin_id: string;

                                    version: string | null;
                                }[];
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/debugger/call": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        input: unknown;
                        name: string;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            data: unknown;

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/debugger/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            data: unknown;

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/device-actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        capability: string;
                        device_id?: string | null;
                        generation: string;
                        input: unknown;
                        provider_id: string;

                        version: number;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/device-providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                definition: {

                                    api_version: number;
                                    capabilities: {

                                        access: "read" | "write";

                                        execution_timeout_ms?: number | null;
                                        id: string;
                                        operation: string;

                                        scope: "provider" | "device";

                                        version: number;
                                    }[];
                                    discover_operation: string;
                                    platform: string;
                                };
                                generation: string;
                                id: string;
                                version: string;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/device-providers/{id}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        generation: string;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                devices: {
                                    capabilities: {
                                        available: boolean;
                                        id: string;
                                        reason?: string | null;

                                        version: number;
                                    }[];
                                    model?: string | null;

                                    raw_state?: string | null;
                                    reference: {
                                        generation: string;
                                        local_id: string;
                                        provider_id: string;
                                    };

                                    state: "online" | "offline" | "unauthorized" | "unknown";
                                }[];
                                discovery_job_id: string;

                                observed_at: number;
                                provider: {
                                    definition: {

                                        api_version: number;
                                        capabilities: {

                                            access: "read" | "write";

                                            execution_timeout_ms?: number | null;
                                            id: string;
                                            operation: string;

                                            scope: "provider" | "device";

                                            version: number;
                                        }[];
                                        discover_operation: string;
                                        platform: string;
                                    };
                                    generation: string;
                                    id: string;
                                    version: string;
                                };
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                502: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                504: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                devices: {
                                    capabilities: {
                                        available: boolean;
                                        id: string;
                                        reason?: string | null;

                                        version: number;
                                    }[];
                                    model?: string | null;

                                    raw_state?: string | null;
                                    reference: {
                                        generation: string;
                                        local_id: string;
                                        provider_id: string;
                                    };

                                    state: "online" | "offline" | "unauthorized" | "unknown";
                                }[];
                                discovery_job_id: string;

                                observed_at: number;
                                provider: {
                                    definition: {

                                        api_version: number;
                                        capabilities: {

                                            access: "read" | "write";

                                            execution_timeout_ms?: number | null;
                                            id: string;
                                            operation: string;

                                            scope: "provider" | "device";

                                            version: number;
                                        }[];
                                        discover_operation: string;
                                        platform: string;
                                    };
                                    generation: string;
                                    id: string;
                                    version: string;
                                };
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/diagnostics/logging": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                dropped_records: number;

                                oversized_records: number;

                                queue_capacity: number;

                                record_limit_bytes: number;

                                write_errors: number;

                                written_bytes: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/diagnostics/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {

                    log_id?: string;

                    q?: string;

                    order?: "asc" | "desc";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                entries: {
                                    code?: string | null;
                                    job_id?: string | null;
                                    level: string;
                                    log_id?: string | null;
                                    message: string;
                                    method?: string | null;
                                    operation?: string | null;
                                    route?: string | null;

                                    status?: number | null;
                                    timestamp: string;
                                }[];
                                job_ids: string[];
                                limited: boolean;
                                log_id?: string | null;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            data: {

                                api_version: 2;

                                status: "ok";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        input: unknown;
                        operation: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                415: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/jobs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/jobs/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    after?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                job_id: string;
                                progress?: {

                                    completed_bytes: number;
                                    resource_id?: string | null;

                                    stage: "preparing" | "downloading" | "verifying" | "deploying" | "activating" | "complete";

                                    total_bytes?: number | null;
                                } | null;

                                sequence: number;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";

                                timestamp: number;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                execution?: {

                                    api_version: number;

                                    source: "default" | "declared";

                                    total_timeout_ms: number;
                                } | null;
                                id: string;
                                input_schema: unknown;
                                title: string;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-configurations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query: {
                    kind: "server";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                applied_revision: number;
                                compatible: boolean;
                                definition?: {

                                    apply_policy: "next_invocation" | "plugin_reload";
                                    defaults: unknown;
                                    legacy_filename?: string | null;
                                    schema: unknown;

                                    version: number;
                                } | null;
                                field_errors: {
                                    message: string;
                                    path: string;
                                }[];
                                id: string;
                                kind: string;
                                pending_reload: boolean;

                                revision: number;

                                source: "legacy" | "managed" | "defaults";
                                values: unknown;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-configurations/{kind}/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: "server";
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    kind: "server";
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                applied_revision: number;
                                compatible: boolean;
                                definition?: {

                                    apply_policy: "next_invocation" | "plugin_reload";
                                    defaults: unknown;
                                    legacy_filename?: string | null;
                                    schema: unknown;

                                    version: number;
                                } | null;
                                field_errors: {
                                    message: string;
                                    path: string;
                                }[];
                                id: string;
                                kind: string;
                                pending_reload: boolean;

                                revision: number;

                                source: "legacy" | "managed" | "defaults";
                                values: unknown;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;

        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    kind: "server";
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        expected_revision: number;
                        patch: unknown;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                applied_revision: number;
                                compatible: boolean;
                                definition?: {

                                    apply_policy: "next_invocation" | "plugin_reload";
                                    defaults: unknown;
                                    legacy_filename?: string | null;
                                    schema: unknown;

                                    version: number;
                                } | null;
                                field_errors: {
                                    message: string;
                                    path: string;
                                }[];
                                id: string;
                                kind: string;
                                pending_reload: boolean;

                                revision: number;

                                source: "legacy" | "managed" | "defaults";
                                values: unknown;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v2/plugin-configurations/{kind}/{id}/apply": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: "server";
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    kind: "server";
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        expected_revision: number;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                applied_revision: number;
                                compatible: boolean;
                                definition?: {

                                    apply_policy: "next_invocation" | "plugin_reload";
                                    defaults: unknown;
                                    legacy_filename?: string | null;
                                    schema: unknown;

                                    version: number;
                                } | null;
                                field_errors: {
                                    message: string;
                                    path: string;
                                }[];
                                id: string;
                                kind: string;
                                pending_reload: boolean;

                                revision: number;

                                source: "legacy" | "managed" | "defaults";
                                values: unknown;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-configurations/{kind}/{id}/reset": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: "server";
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    kind: "server";
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        expected_revision: number;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                applied_revision: number;
                                compatible: boolean;
                                definition?: {

                                    apply_policy: "next_invocation" | "plugin_reload";
                                    defaults: unknown;
                                    legacy_filename?: string | null;
                                    schema: unknown;

                                    version: number;
                                } | null;
                                field_errors: {
                                    message: string;
                                    path: string;
                                }[];
                                id: string;
                                kind: string;
                                pending_reload: boolean;

                                revision: number;

                                source: "legacy" | "managed" | "defaults";
                                values: unknown;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-dependencies/{target_kind}/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                target_kind: "release" | "server" | "browser";
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    target_kind: "release" | "server" | "browser";
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                dependencies: {
                                    id: string;
                                    installable: boolean;
                                    message?: string | null;
                                    name: string;
                                    required: boolean;

                                    source?: "environment" | "shared" | "local" | null;

                                    status: "ready" | "missing" | "incompatible" | "failed";
                                    version?: string | null;
                                    version_requirement: string;
                                }[];
                                ready: boolean;
                                revision: string;
                                target: {
                                    id: string;

                                    kind: "release" | "server" | "browser";
                                };
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-dependencies/{target_kind}/{id}/install": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                target_kind: "release" | "server" | "browser";
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    target_kind: "release" | "server" | "browser";
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        dependency_ids?: string[];
                        expected_revision: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                415: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                502: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-dependencies/{target_kind}/{id}/scan": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                target_kind: "release" | "server" | "browser";
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    target_kind: "release" | "server" | "browser";
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        dependency_ids?: string[];
                        expected_revision: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                415: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                502: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-installations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                components: {
                                    entry_path: string;
                                    entry_url?: string | null;
                                    id: string;

                                    kind: "server" | "browser";
                                    revision: string;
                                    version: string;
                                }[];
                                description: string;
                                enabled: boolean;

                                failure: {
                                    phase: string;
                                    reason: string;
                                } | null;
                                id: string;

                                installed_at: number;
                                name: string;
                                requirements: {

                                    any_of?: string[];
                                    component_id: string;
                                    config_pointer: string;
                                    description: string;

                                    required: boolean;

                                    sensitive: boolean;
                                    title: string;
                                }[];

                                revision: string;

                                status: "installed" | "enabled" | "configuration_required" | "dependencies_required" | "recovery_blocked";
                                tools: {

                                    entries: string[];
                                    id: string;
                                    platform: string;
                                    sha256: string;
                                    version: string;
                                }[];
                                version: string;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        expected_revision?: string | null;
                        source: {

                            kind: "market";
                            manifest_sha256: string;
                            release_id: string;
                            source_url: string;
                            version: string;
                        } | {
                            artifact_id: string;

                            kind: "offline";
                        };
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-installations/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query: {
                    filename: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/octet-stream": string;
                };
            };
            responses: {

                201: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                filename: string;
                                id: string;
                                media_type: string;
                                sha256: string;

                                size: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-installations/browser/{id}/revisions/{revision}/assets/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    revision: string;
                    path: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/octet-stream": string;
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-installations/cleanup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        dry_run?: boolean;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-installations/plan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        kind: "market";
                        manifest_sha256: string;
                        release_id: string;
                        source_url: string;
                        version: string;
                    } | {
                        artifact_id: string;

                        kind: "offline";
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                actions: ("download" | "reuse" | "verify" | "install" | "preserve_previous")[];

                                download_size: number;
                                id: string;
                                issues: {
                                    code: string;
                                    message: string;
                                    required: boolean;
                                }[];
                                resources: {
                                    id: string;
                                    kind: string;
                                    platform: string;
                                    required: boolean;
                                    reused: boolean;
                                    sha256: string;

                                    size: number;
                                    version: string;
                                }[];
                                revision: string;
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-installations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                components: {
                                    entry_path: string;
                                    entry_url?: string | null;
                                    id: string;

                                    kind: "server" | "browser";
                                    revision: string;
                                    version: string;
                                }[];
                                description: string;
                                enabled: boolean;

                                failure: {
                                    phase: string;
                                    reason: string;
                                } | null;
                                id: string;

                                installed_at: number;
                                name: string;
                                requirements: {

                                    any_of?: string[];
                                    component_id: string;
                                    config_pointer: string;
                                    description: string;

                                    required: boolean;

                                    sensitive: boolean;
                                    title: string;
                                }[];

                                revision: string;

                                status: "installed" | "enabled" | "configuration_required" | "dependencies_required" | "recovery_blocked";
                                tools: {

                                    entries: string[];
                                    id: string;
                                    platform: string;
                                    sha256: string;
                                    version: string;
                                }[];
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };

        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        expected_revision?: string | null;
                        source: {

                            kind: "market";
                            manifest_sha256: string;
                            release_id: string;
                            source_url: string;
                            version: string;
                        } | {
                            artifact_id: string;

                            kind: "offline";
                        };
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        post?: never;

        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expected_revision: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-installations/{id}/enabled": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;

        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        enabled: boolean;
                        expected_revision: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v2/plugin-installations/{id}/previous-successful": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query: {
                    expected_revision: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                activated_at: number;
                                release: {
                                    components: {
                                        entry_path: string;
                                        entry_url?: string | null;
                                        id: string;

                                        kind: "server" | "browser";
                                        revision: string;
                                        version: string;
                                    }[];
                                    description: string;
                                    enabled: boolean;

                                    failure: {
                                        phase: string;
                                        reason: string;
                                    } | null;
                                    id: string;

                                    installed_at: number;
                                    name: string;
                                    requirements: {

                                        any_of?: string[];
                                        component_id: string;
                                        config_pointer: string;
                                        description: string;

                                        required: boolean;

                                        sensitive: boolean;
                                        title: string;
                                    }[];

                                    revision: string;

                                    status: "installed" | "enabled" | "configuration_required" | "dependencies_required" | "recovery_blocked";
                                    tools: {

                                        entries: string[];
                                        id: string;
                                        platform: string;
                                        sha256: string;
                                        version: string;
                                    }[];
                                    version: string;
                                };

                                scope: "host_activation";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-installations/{id}/reload": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        confirmed: boolean;
                        expected_revision: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-installations/{id}/restore-successful": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        confirmed: boolean;
                        expected_revision: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-packages/{kind}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    kind: "server" | "browser";
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                api_version?: number | null;
                                entry_path: string;
                                entry_url?: string | null;
                                id: string;

                                installed_at: number;

                                kind: "server" | "browser";
                                runtime: string;
                                version: string;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;

        post: {
            parameters: {
                query: {
                    format: "zip" | "tgz";

                    expected_id?: string;

                    expected_version?: string;
                };
                header?: never;
                path: {
                    kind: "server" | "browser";
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/gzip": string;
                    "application/zip": string;
                };
            };
            responses: {

                201: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                api_version?: number | null;
                                entry_path: string;
                                entry_url?: string | null;
                                id: string;

                                installed_at: number;

                                kind: "server" | "browser";
                                runtime: string;
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-packages/{kind}/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;

        put: {
            parameters: {
                query: {
                    format: "zip" | "tgz";

                    expected_id?: string;

                    expected_version?: string;
                };
                header?: never;
                path: {
                    kind: "server" | "browser";
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/gzip": string;
                    "application/zip": string;
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                api_version?: number | null;
                                entry_path: string;
                                entry_url?: string | null;
                                id: string;

                                installed_at: number;

                                kind: "server" | "browser";
                                runtime: string;
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        post?: never;

        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    kind: "server" | "browser";
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                api_version?: number | null;
                                entry_path: string;
                                entry_url?: string | null;
                                id: string;

                                installed_at: number;

                                kind: "server" | "browser";
                                runtime: string;
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                cleanup_failed: boolean;
                                generation: string;
                                id: string;

                                metadata?: {
                                    description: string;
                                    name: string;
                                    summary: string;
                                } | null;
                                operations: string[];
                                protected: boolean;
                                sessions?: string[];

                                state: "loaded" | "draining" | "unloaded";
                                version: string;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugins/{id}/load": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                cleanup_failed: boolean;
                                generation: string;
                                id: string;

                                metadata?: {
                                    description: string;
                                    name: string;
                                    summary: string;
                                } | null;
                                operations: string[];
                                protected: boolean;
                                sessions?: string[];

                                state: "loaded" | "draining" | "unloaded";
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                504: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugins/{id}/recovery": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                cleanup_failed: boolean;
                                generation: string;
                                id: string;
                                last_report?: {
                                    checks: {
                                        message: string;
                                        resource: string;

                                        status: "confirmed" | "blocked" | "busy";
                                    }[];
                                    coverage: string;

                                    inspected: number;
                                    message: string;

                                    remaining: number;

                                    status: "recovered" | "blocked" | "busy";
                                } | null;
                                recovering: boolean;
                                supported: boolean;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        generation: string;

                        input?: unknown;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                cleanup_failed: boolean;
                                generation: string;
                                id: string;
                                last_report?: {
                                    checks: {
                                        message: string;
                                        resource: string;

                                        status: "confirmed" | "blocked" | "busy";
                                    }[];
                                    coverage: string;

                                    inspected: number;
                                    message: string;

                                    remaining: number;

                                    status: "recovered" | "blocked" | "busy";
                                } | null;
                                recovering: boolean;
                                supported: boolean;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugins/{id}/unload": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                cleanup_failed: boolean;
                                generation: string;
                                id: string;

                                metadata?: {
                                    description: string;
                                    name: string;
                                    summary: string;
                                } | null;
                                operations: string[];
                                protected: boolean;
                                sessions?: string[];

                                state: "loaded" | "draining" | "unloaded";
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                504: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/services": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                available: boolean;
                                contract: {
                                    input_schema: unknown;
                                    output_schema: unknown;
                                };
                                operation: string;
                                provider: {
                                    generation: string;
                                    id: string;
                                    version: string;
                                };
                                service: {
                                    id: string;
                                    version: string;
                                };
                                unavailable_reason?: string | null;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/services/{id}/calls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {

                        generation?: string | null;
                        input: unknown;
                        version: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/session-definitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                revision: number;
                                sessions: {

                                    execution?: {

                                        api_version: number;

                                        source: "default" | "declared";

                                        total_timeout_ms: number;
                                    } | null;
                                    id: string;
                                    input_schema: unknown;

                                    output_retention?: "complete" | "bounded_tail";
                                    title: string;
                                }[];
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                completion?: {
                                    cleanup: "complete" | "failed" | "unconfirmed";
                                    failure?: {
                                        code: string;
                                        message: string;
                                    } | null;

                                    outcome?: {
                                        artifacts: {

                                            created_at: number;
                                            filename: string;
                                            id: string;
                                            media_type: string;
                                            sha256: string;

                                            size: number;
                                        }[];
                                        error?: string | null;
                                        result?: unknown;
                                    } | null;
                                    process_exited: boolean;

                                    sequence?: number | null;
                                } | null;

                                created_at: number;
                                generation: string;
                                id: string;
                                operation: string;

                                output_sequence: number;
                                plugin_id: string;

                                status: "opening" | "running" | "stopping" | "finished";
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        input: unknown;
                        operation: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                completion?: {
                                    cleanup: "complete" | "failed" | "unconfirmed";
                                    failure?: {
                                        code: string;
                                        message: string;
                                    } | null;

                                    outcome?: {
                                        artifacts: {

                                            created_at: number;
                                            filename: string;
                                            id: string;
                                            media_type: string;
                                            sha256: string;

                                            size: number;
                                        }[];
                                        error?: string | null;
                                        result?: unknown;
                                    } | null;
                                    process_exited: boolean;

                                    sequence?: number | null;
                                } | null;

                                created_at: number;
                                generation: string;
                                id: string;
                                operation: string;

                                output_sequence: number;
                                plugin_id: string;

                                status: "opening" | "running" | "stopping" | "finished";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                completion?: {
                                    cleanup: "complete" | "failed" | "unconfirmed";
                                    failure?: {
                                        code: string;
                                        message: string;
                                    } | null;

                                    outcome?: {
                                        artifacts: {

                                            created_at: number;
                                            filename: string;
                                            id: string;
                                            media_type: string;
                                            sha256: string;

                                            size: number;
                                        }[];
                                        error?: string | null;
                                        result?: unknown;
                                    } | null;
                                    process_exited: boolean;

                                    sequence?: number | null;
                                } | null;

                                created_at: number;
                                generation: string;
                                id: string;
                                operation: string;

                                output_sequence: number;
                                plugin_id: string;

                                status: "opening" | "running" | "stopping" | "finished";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;

        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                id: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                completion?: {
                                    cleanup: "complete" | "failed" | "unconfirmed";
                                    failure?: {
                                        code: string;
                                        message: string;
                                    } | null;

                                    outcome?: {
                                        artifacts: {

                                            created_at: number;
                                            filename: string;
                                            id: string;
                                            media_type: string;
                                            sha256: string;

                                            size: number;
                                        }[];
                                        error?: string | null;
                                        result?: unknown;
                                    } | null;
                                    process_exited: boolean;

                                    sequence?: number | null;
                                } | null;

                                created_at: number;
                                generation: string;
                                id: string;
                                operation: string;

                                output_sequence: number;
                                plugin_id: string;

                                status: "opening" | "running" | "stopping" | "finished";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{id}/eof": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                accepted: boolean;
                                id: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{id}/input": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        bytes: number[];
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                accepted: boolean;
                                id: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{id}/output": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    after?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                chunks: {
                                    bytes: number[];

                                    sequence: number;

                                    stream: "stdout" | "stderr";
                                }[];

                                next_sequence: number;
                                session: {
                                    completion?: {
                                        cleanup: "complete" | "failed" | "unconfirmed";
                                        failure?: {
                                            code: string;
                                            message: string;
                                        } | null;

                                        outcome?: {
                                            artifacts: {

                                                created_at: number;
                                                filename: string;
                                                id: string;
                                                media_type: string;
                                                sha256: string;

                                                size: number;
                                            }[];
                                            error?: string | null;
                                            result?: unknown;
                                        } | null;
                                        process_exited: boolean;

                                        sequence?: number | null;
                                    } | null;

                                    created_at: number;
                                    generation: string;
                                    id: string;
                                    operation: string;

                                    output_sequence: number;
                                    plugin_id: string;

                                    status: "opening" | "running" | "stopping" | "finished";
                                };
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{id}/release": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                completion?: {
                                    cleanup: "complete" | "failed" | "unconfirmed";
                                    failure?: {
                                        code: string;
                                        message: string;
                                    } | null;

                                    outcome?: {
                                        artifacts: {

                                            created_at: number;
                                            filename: string;
                                            id: string;
                                            media_type: string;
                                            sha256: string;

                                            size: number;
                                        }[];
                                        error?: string | null;
                                        result?: unknown;
                                    } | null;
                                    process_exited: boolean;

                                    sequence?: number | null;
                                } | null;

                                created_at: number;
                                generation: string;
                                id: string;
                                operation: string;

                                output_sequence: number;
                                plugin_id: string;

                                status: "opening" | "running" | "stopping" | "finished";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/system/shutdown": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            data: {
                                stopping: boolean;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {

        ApksInstalled: {
            artifact_id: string;
            device_id: string;
            installed: boolean;
        };

        BrowserConfigurationPatch: {

            expected_revision: string | null;
            record: {
                applied: string;
                revision: string;
                sensitivePaths: string[];
                values: unknown;

                version: number;
            };
        };

        BrowserConfigurationRecord: {
            applied: string;
            revision: string;
            sensitivePaths: string[];
            values: unknown;

            version: number;
        };

        BrowserConfigurationView: {
            record: {
                applied: string;
                revision: string;
                sensitivePaths: string[];
                values: unknown;

                version: number;
            } | null;
        };

        BuildApksRequest: {
            artifact_id: string;

            mode: "default" | "universal";
        };

        BuiltApks: {

            apk_count: number;
            artifact: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            };

            mode: "default" | "universal";
            source_artifact_id: string;
            universal_entry?: string | null;
        };

        ConfigurationDefinition: {

            apply_policy: "next_invocation" | "plugin_reload";
            defaults: unknown;
            legacy_filename?: string | null;
            schema: unknown;

            version: number;
        };

        ConfigurationFieldError: {
            message: string;
            path: string;
        };

        ConfigurationPatch: {

            expected_revision: number;
            patch: unknown;
        };

        ConfigurationRevision: {

            expected_revision: number;
        };

        DebuggerBridgeAck: {
            command_id: string;

            generation: string | null;
            instance_id: string;
            plugin_id: string;

            response: unknown;
            success: boolean;
        };

        DebuggerBridgeBatch: {
            active_sessions: {

                idle_ttl_ms: number;
                session_id: string;

                state: "active" | "closed" | "expired" | "disconnected" | "target_changed";
                target: {

                    generation: string | null;

                    instance_id: string | null;
                    plugin_id: string;

                    target_kind: "browser" | "server";

                    version: string | null;
                };
            }[];
            commands: {
                command_id: string;
                parameters: unknown;

                remaining_ms: number;
                session_id: string;
                target: {

                    generation: string | null;

                    instance_id: string | null;
                    plugin_id: string;

                    target_kind: "browser" | "server";

                    version: string | null;
                };

                tool: "inspect" | "ui_tree" | "ui_query" | "ui_diff" | "ui_assert" | "ui_action" | "invoke" | "reload" | "report";
            }[];
            instance_id: string;
            targets: {

                generation: string | null;

                instance_id: string | null;
                plugin_id: string;

                target_kind: "browser" | "server";

                version: string | null;
            }[];
        };

        DebuggerBridgeHeartbeat: {
            instance_id: string;

            plugins: {

                generation: string | null;
                plugin_id: string;

                version: string | null;
            }[] | null;
        };

        DebuggerBridgePlugin: {

            generation: string | null;
            plugin_id: string;

            version: string | null;
        };

        DebuggerBridgePoll: {
            instance_id: string;

            limit: number;
        };

        DebuggerBridgeRegistration: {

            plugins: {

                generation: string | null;
                plugin_id: string;

                version: string | null;
            }[];
        };

        DebuggerBridgeStatus: {
            active_sessions: {

                idle_ttl_ms: number;
                session_id: string;

                state: "active" | "closed" | "expired" | "disconnected" | "target_changed";
                target: {

                    generation: string | null;

                    instance_id: string | null;
                    plugin_id: string;

                    target_kind: "browser" | "server";

                    version: string | null;
                };
            }[];
            instance_id: string;
            targets: {

                generation: string | null;

                instance_id: string | null;
                plugin_id: string;

                target_kind: "browser" | "server";

                version: string | null;
            }[];
        };

        DebuggerBrowserInstance: {

            active_sessions: number;

            idle_ttl_ms: number;
            instance_id: string;
            plugins: {

                generation: string | null;
                plugin_id: string;

                version: string | null;
            }[];
        };

        DebuggerCommandReceipt: {
            command_id: string;
            session_id: string;
            state: ("queued" | "delivered" | "succeeded" | "failed" | "cancelled_unconfirmed") | "timed_out_unconfirmed";

            timeout_ms: number;
        };

        DebuggerCommandResult: {
            command_id: string;
            response?: unknown;
            session_id: string;
            state: ("queued" | "delivered" | "succeeded" | "failed" | "cancelled_unconfirmed") | "timed_out_unconfirmed";
        };

        DebuggerEventPage: {

            dropped_events: number;
            events: {
                command_id?: string | null;
                command_state?: (("queued" | "delivered" | "succeeded" | "failed" | "cancelled_unconfirmed") | "timed_out_unconfirmed") | null;
                instance_id?: string | null;

                kind: "instance_registered" | "instance_disconnected" | "session_opened" | "session_target_selected" | "session_ended" | "command_queued" | "command_delivered" | "command_finished";

                sequence: number;
                session_id?: string | null;

                session_state?: "active" | "closed" | "expired" | "disconnected" | "target_changed" | null;
            }[];
            gap: boolean;

            latest_sequence: number;

            next_after: number;

            oldest_available: number;

            retained_bytes: number;
        };

        DebuggerEventQuery: {

            after: number;

            limit: number;

            session_id: string | null;
        };

        DebuggerSession: {

            idle_ttl_ms: number;
            session_id: string;

            state: "active" | "closed" | "expired" | "disconnected" | "target_changed";
            target: {

                generation: string | null;

                instance_id: string | null;
                plugin_id: string;

                target_kind: "browser" | "server";

                version: string | null;
            };
        };

        DebuggerTarget: {

            generation: string | null;

            instance_id: string | null;
            plugin_id: string;

            target_kind: "browser" | "server";

            version: string | null;
        };

        DebuggerToolCall: {
            input: unknown;
            name: string;
        };

        DecodedPackage: {
            artifact: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            };

            files: number;
            source_artifact_id: string;

            unpacked_size: number;
        };

        DependencyChange: {

            dependency_ids: string[];
            expected_revision: string;
        };

        DependencyOrigin: "environment" | "shared" | "local";

        DependencyRequest: {

            dependency_ids: string[];
            expected_revision: string;
            target: {
                id: string;

                kind: "release" | "server" | "browser";
            };
        };

        DependencyStatus: "ready" | "missing" | "incompatible" | "failed";

        DependencyTarget: {
            id: string;

            kind: "release" | "server" | "browser";
        };

        DependencyTargetKind: "release" | "server" | "browser";

        DependencyView: {
            id: string;
            installable: boolean;
            message?: string | null;
            name: string;
            required: boolean;

            source?: "environment" | "shared" | "local" | null;

            status: "ready" | "missing" | "incompatible" | "failed";
            version?: string | null;
            version_requirement: string;
        };

        DeviceActionRequest: {
            capability: string;
            device_id?: string | null;
            generation: string;
            input: unknown;
            provider_id: string;

            version: number;
        };

        DeviceDirectory: {
            devices: {
                capabilities: {
                    available: boolean;
                    id: string;
                    reason?: string | null;

                    version: number;
                }[];
                model?: string | null;

                raw_state?: string | null;
                reference: {
                    generation: string;
                    local_id: string;
                    provider_id: string;
                };

                state: "online" | "offline" | "unauthorized" | "unknown";
            }[];
            discovery_job_id: string;

            observed_at: number;
            provider: {
                definition: {

                    api_version: number;
                    capabilities: {

                        access: "read" | "write";

                        execution_timeout_ms?: number | null;
                        id: string;
                        operation: string;

                        scope: "provider" | "device";

                        version: number;
                    }[];
                    discover_operation: string;
                    platform: string;
                };
                generation: string;
                id: string;
                version: string;
            };
        };

        DeviceProviderInfo: {
            definition: {

                api_version: number;
                capabilities: {

                    access: "read" | "write";

                    execution_timeout_ms?: number | null;
                    id: string;
                    operation: string;

                    scope: "provider" | "device";

                    version: number;
                }[];
                discover_operation: string;
                platform: string;
            };
            generation: string;
            id: string;
            version: string;
        };

        ErrorResponse: {
            error: {
                code: string;
                message: string;
            };
            log_id: string;
        };

        ExtractedApk: {
            artifact: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            };
            entry: string;
            source_artifact_id: string;
        };

        ExtractedSplits: {
            apk_entries: string[];
            artifact: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            };

            device_spec: {

                screen_density: number;

                sdk_version: number;
                supported_abis: string[];
                supported_locales: string[];
            };
            source_artifact_id: string;
        };

        InputReceipt: {
            action: string;
            device_id: string;
            dispatched: boolean;
        };

        InputRequest: {

            action: {

                kind: "tap";

                x: number;

                y: number;
            } | {

                duration_ms: number;

                kind: "swipe";

                x1: number;

                x2: number;

                y1: number;

                y2: number;
            } | {

                key_code: number;

                kind: "keyevent";

                long_press: boolean;
            } | {

                enter: boolean;

                kind: "text";
                text: string;
            };
            device_id: string;
        };

        JobResponse: {
            data: {

                created_at: number;
                error?: string | null;
                id: string;
                input: unknown;
                operation: string;
                result?: unknown;

                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
            };
            log_id: string;
        };

        PackageManifest: {
            application_label?: string | null;
            artifact_id: string;
            debuggable?: boolean | null;

            format: "apk" | "aab";
            min_sdk?: string | null;
            module?: string | null;
            package_name: string;
            permissions: string[];
            target_sdk?: string | null;
            version_code?: string | null;
            version_name?: string | null;
            xml: string;
        };

        PackageSignature: {
            artifact_id: string;
            report: string;
            schemes: {
                scheme: string;
                verified: boolean;
            }[];
            signers: {
                certificate_sha256: string;
                distinguished_name?: string | null;

                number: number;
            }[];
            verified: boolean;
        };

        PerformancePage: {

            next_after: number;
            readings: {

                battery_net_power_mw?: number | null;

                captured_at: number;

                cpu_core_percent?: number | null;

                cpu_share_percent?: number | null;
                device_observation?: {

                    api_version: number;
                    battery?: {

                        access: "adb_shell" | "root_shell";

                        current_polarity: "positive_charging" | "positive_discharging" | "unknown";

                        current_ua?: number | null;

                        observed_at: number;
                        source: string;

                        status?: "unknown" | "charging" | "discharging" | "not_charging" | "full" | null;

                        supply_state: "battery" | "external" | "unknown";

                        voltage_uv: number;
                    } | null;
                    device_id: string;

                    scope: "device";
                    temperatures: {

                        access: "adb_shell" | "root_shell";

                        observed_at: number;

                        sensor_kind: "cpu" | "gpu" | "battery" | "skin" | "other";
                        sensor_name: string;

                        sensor_type?: number | null;
                        source: string;

                        status?: number | null;

                        temperature_celsius: number;
                    }[];
                } | null;

                fps?: number | null;
                frame_window?: {

                    duration_ms: number;

                    frames: number;
                    source: string;
                } | null;

                logical_cpus?: number | null;
                metric_missing?: {

                    api_version: number;
                    cpu?: {

                        access: "adb_shell" | "root_shell";

                        reason: "permission_denied" | "unsupported";
                        source: string;
                    } | null;
                    memory?: {

                        access: "adb_shell" | "root_shell";

                        reason: "permission_denied" | "unsupported";
                        source: string;
                    } | null;
                } | null;

                pid: number;

                pss_kib?: number | null;

                rss_kib?: number | null;

                sequence: number;
            }[];
            session: {
                error?: string | null;
                id: string;
                request: {

                    duration_secs: number;

                    interval_ms: number;
                    target: {
                        device_id: string;
                        package: string;
                    };
                };

                revision: number;

                samples: number;

                source?: {
                    device?: {
                        generation: string;
                        local_id: string;
                        provider_id: string;
                    } | null;
                    generation: string;
                    operation: string;
                    plugin_id: string;
                } | null;

                started_at: number;

                state: "running" | "paused" | "stopped" | "completed" | "failed" | "interrupted";

                updated_at: number;
            };
        };

        PerformanceSession: {
            error?: string | null;
            id: string;
            request: {

                duration_secs: number;

                interval_ms: number;
                target: {
                    device_id: string;
                    package: string;
                };
            };

            revision: number;

            samples: number;

            source?: {
                device?: {
                    generation: string;
                    local_id: string;
                    provider_id: string;
                } | null;
                generation: string;
                operation: string;
                plugin_id: string;
            } | null;

            started_at: number;

            state: "running" | "paused" | "stopped" | "completed" | "failed" | "interrupted";

            updated_at: number;
        };

        PerformanceSessions: {
            next_after_id?: string | null;
            sessions: {
                error?: string | null;
                id: string;
                request: {

                    duration_secs: number;

                    interval_ms: number;
                    target: {
                        device_id: string;
                        package: string;
                    };
                };

                revision: number;

                samples: number;

                source?: {
                    device?: {
                        generation: string;
                        local_id: string;
                        provider_id: string;
                    } | null;
                    generation: string;
                    operation: string;
                    plugin_id: string;
                } | null;

                started_at: number;

                state: "running" | "paused" | "stopped" | "completed" | "failed" | "interrupted";

                updated_at: number;
            }[];
        };

        PluginArtifactResult: {
            artifacts: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            }[];
            result: unknown;
        };

        PluginConfiguration: {

            applied_revision: number;
            compatible: boolean;
            definition?: {

                apply_policy: "next_invocation" | "plugin_reload";
                defaults: unknown;
                legacy_filename?: string | null;
                schema: unknown;

                version: number;
            } | null;
            field_errors: {
                message: string;
                path: string;
            }[];
            id: string;
            kind: string;
            pending_reload: boolean;

            revision: number;

            source: "legacy" | "managed" | "defaults";
            values: unknown;
        };

        PluginDependencies: {
            dependencies: {
                id: string;
                installable: boolean;
                message?: string | null;
                name: string;
                required: boolean;

                source?: "environment" | "shared" | "local" | null;

                status: "ready" | "missing" | "incompatible" | "failed";
                version?: string | null;
                version_requirement: string;
            }[];
            ready: boolean;
            revision: string;
            target: {
                id: string;

                kind: "release" | "server" | "browser";
            };
        };

        PluginInstallation: {
            components: {
                entry_path: string;
                entry_url?: string | null;
                id: string;

                kind: "server" | "browser";
                revision: string;
                version: string;
            }[];
            description: string;
            enabled: boolean;

            failure: {
                phase: string;
                reason: string;
            } | null;
            id: string;

            installed_at: number;
            name: string;
            requirements: {

                any_of?: string[];
                component_id: string;
                config_pointer: string;
                description: string;

                required: boolean;

                sensitive: boolean;
                title: string;
            }[];

            revision: string;

            status: "installed" | "enabled" | "configuration_required" | "dependencies_required" | "recovery_blocked";
            tools: {

                entries: string[];
                id: string;
                platform: string;
                sha256: string;
                version: string;
            }[];
            version: string;
        };

        PluginInstallationPlan: {
            actions: ("download" | "reuse" | "verify" | "install" | "preserve_previous")[];

            download_size: number;
            id: string;
            issues: {
                code: string;
                message: string;
                required: boolean;
            }[];
            resources: {
                id: string;
                kind: string;
                platform: string;
                required: boolean;
                reused: boolean;
                sha256: string;

                size: number;
                version: string;
            }[];
            revision: string;
            version: string;
        };

        PluginInstallationSource: {

            kind: "market";
            manifest_sha256: string;
            release_id: string;
            source_url: string;
            version: string;
        } | {
            artifact_id: string;

            kind: "offline";
        };

        PluginInstallationSuccessfulRelease: {

            activated_at: number;
            release: {
                components: {
                    entry_path: string;
                    entry_url?: string | null;
                    id: string;

                    kind: "server" | "browser";
                    revision: string;
                    version: string;
                }[];
                description: string;
                enabled: boolean;

                failure: {
                    phase: string;
                    reason: string;
                } | null;
                id: string;

                installed_at: number;
                name: string;
                requirements: {

                    any_of?: string[];
                    component_id: string;
                    config_pointer: string;
                    description: string;

                    required: boolean;

                    sensitive: boolean;
                    title: string;
                }[];

                revision: string;

                status: "installed" | "enabled" | "configuration_required" | "dependencies_required" | "recovery_blocked";
                tools: {

                    entries: string[];
                    id: string;
                    platform: string;
                    sha256: string;
                    version: string;
                }[];
                version: string;
            };

            scope: "host_activation";
        };

        PluginPackageFormat: "zip" | "tgz";

        PluginPackageInfo: {

            api_version?: number | null;
            entry_path: string;
            entry_url?: string | null;
            id: string;

            installed_at: number;

            kind: "server" | "browser";
            runtime: string;
            version: string;
        };

        PluginPackageKind: "server" | "browser";

        PluginReleaseManifest: {
            components: {
                id: string;

                kind: "server" | "browser";
                variants: {

                    format: "zip" | "tgz" | "file";

                    path: string;
                    platform: string;
                    sha256: string;

                    size: number;
                }[];
                version: string;
            }[];
            dependencies?: {

                dependencies: {

                    bindings: {

                        component_id: string;
                        config_pointer: string;
                        entry: string;
                    }[];

                    discovery: {

                        entries: {
                            [key: string]: string;
                        };

                        kind: "environment" | "path" | "user_directory";

                        value: string;
                    }[];
                    entries: string[];
                    id: string;
                    name: string;

                    probe: {

                        args: string[];
                        entry: string;

                        pattern: string;

                        timeout_ms: number;
                    } | null;

                    required: boolean;

                    requires: string[];

                    sources: {
                        entries: {
                            [key: string]: string;
                        };

                        format: "zip" | "tgz" | "file";

                        kind: "market" | "official";
                        platform: string;
                        sha256: string;

                        size: number;
                        url: string;
                        version: string;
                    }[];
                    version_requirement: string;
                }[];

                format_version: number;
            } | null;
            description: string;

            format_version: number;

            host_api_version: number;
            id: string;
            name: string;

            requirements: {

                any_of?: string[];
                component_id: string;
                config_pointer: string;
                description: string;

                required: boolean;

                sensitive: boolean;
                title: string;
            }[];

            tools: {

                bindings: {
                    component_id: string;
                    config_pointer: string;
                    entry: string;
                }[];
                id: string;

                required: boolean;
                variants: {

                    entries: {
                        [key: string]: string;
                    };

                    format: "zip" | "tgz" | "file";
                    path: string;
                    platform: string;
                    sha256: string;

                    size: number;
                }[];
                version: string;
            }[];
            version: string;
        };

        PluginResourceCleanupReport: {
            dry_run: boolean;
            items: {

                bytes: number;

                resource: string;
            }[];

            total_bytes: number;
        };

        ProviderInput: {
            generation: string;
            id: string;
        };

        RecoveryInput: {
            generation: string;

            input: unknown;
        };

        RecoveryView: {
            cleanup_failed: boolean;
            generation: string;
            id: string;
            last_report?: {
                checks: {
                    message: string;
                    resource: string;

                    status: "confirmed" | "blocked" | "busy";
                }[];
                coverage: string;

                inspected: number;
                message: string;

                remaining: number;

                status: "recovered" | "blocked" | "busy";
            } | null;
            recovering: boolean;
            supported: boolean;
        };

        SdkScan: {
            artifact_id: string;
            findings: {
                class_found?: boolean | null;
                evidence: string[];
                package_found: boolean;
                rule: {
                    class_name?: string | null;
                    name: string;
                    package_path: string;
                };
            }[];
        };

        ServiceCallRequest: {

            generation: string | null;
            input: unknown;
            version: string;
        };

        ServiceContract: {
            input_schema: unknown;
            output_schema: unknown;
        };

        ServiceInfo: {
            available: boolean;
            contract: {
                input_schema: unknown;
                output_schema: unknown;
            };
            operation: string;
            provider: {
                generation: string;
                id: string;
                version: string;
            };
            service: {
                id: string;
                version: string;
            };
            unavailable_reason?: string | null;
        };

        ServiceProvider: {
            generation: string;
            id: string;
            version: string;
        };

        ServiceRef: {
            id: string;
            version: string;
        };

        SessionBytesInput: {
            bytes: number[];
        };

        SessionDefinitions: {

            revision: number;
            sessions: {

                execution?: {

                    api_version: number;

                    source: "default" | "declared";

                    total_timeout_ms: number;
                } | null;
                id: string;
                input_schema: unknown;

                output_retention?: "complete" | "bounded_tail";
                title: string;
            }[];
        };

        SessionInfo: {
            completion?: {
                cleanup: "complete" | "failed" | "unconfirmed";
                failure?: {
                    code: string;
                    message: string;
                } | null;

                outcome?: {
                    artifacts: {

                        created_at: number;
                        filename: string;
                        id: string;
                        media_type: string;
                        sha256: string;

                        size: number;
                    }[];
                    error?: string | null;
                    result?: unknown;
                } | null;
                process_exited: boolean;

                sequence?: number | null;
            } | null;

            created_at: number;
            generation: string;
            id: string;
            operation: string;

            output_sequence: number;
            plugin_id: string;

            status: "opening" | "running" | "stopping" | "finished";
        };

        SessionOutputPage: {
            chunks: {
                bytes: number[];

                sequence: number;

                stream: "stdout" | "stderr";
            }[];

            next_sequence: number;
            session: {
                completion?: {
                    cleanup: "complete" | "failed" | "unconfirmed";
                    failure?: {
                        code: string;
                        message: string;
                    } | null;

                    outcome?: {
                        artifacts: {

                            created_at: number;
                            filename: string;
                            id: string;
                            media_type: string;
                            sha256: string;

                            size: number;
                        }[];
                        error?: string | null;
                        result?: unknown;
                    } | null;
                    process_exited: boolean;

                    sequence?: number | null;
                } | null;

                created_at: number;
                generation: string;
                id: string;
                operation: string;

                output_sequence: number;
                plugin_id: string;

                status: "opening" | "running" | "stopping" | "finished";
            };
        };

        SessionReceipt: {
            accepted: boolean;
            id: string;
        };

        SessionRemoved: {
            id: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
